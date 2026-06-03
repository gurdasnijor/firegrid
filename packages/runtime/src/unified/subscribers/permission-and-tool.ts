/**
 * Permission roundtrip + tool dispatch — two specialized workflow
 * bodies.
 *
 * Each subscriber is specialized to its concern. There is deliberately
 * NO generic "wait_for any fact" workflow — string-dispatch over a
 * fact-table name reconstructs the retired SourceCollections /
 * RuntimeObservationSourceNames registry pattern.
 *
 * State minimalism: neither body keeps a parallel result table. The
 * engine activity table memoizes activity returns; the engine
 * execution table records each body's final result. The `permissions`
 * row holds only what the UI needs to render an open request — no
 * lifecycle status flag.
 *
 * Phase 3 feedback loop (SDD §D / §E): each workflow ends with a
 * terminal `Activity.make` that `sendSignal`s the result back to the
 * originating session workflow as a `SessionInputPayload`. This bakes
 * the relay into the workflow itself — no driver-side send required.
 */

import { Prompt } from "@effect/ai"
import {
  Activity,
  DurableDeferred,
  Workflow,
  type WorkflowEngine,
} from "@effect/workflow"
import { Clock, Effect, Ref, Schema } from "effect"
import { UnifiedTable, permissionKey } from "../tables.ts"
import {
  RuntimeContextSessionWorkflow,
} from "./runtime-context.ts"
import {
  type SessionInputPayload,
} from "../adapter.ts"
import {
  AgentInputEventSchema,
} from "../../events/contract.ts"

const encodeAgentInputEventJson = Schema.encodeSync(
  Schema.parseJson(AgentInputEventSchema),
)

// ── Shared: session relay ───────────────────────────────────────────────────
//
// tf-k00i: each sibling workflow's result is itself a session input. The relay
// EXECUTES a fresh per-event RuntimeContext handler with the result carried in
// the payload (Effect-native `Workflow.execute({discard})`), replacing the old
// `sendSignal` to the parked body. Activity-memoized so it relays exactly once.

const relaySessionInput = (options: {
  readonly activityName: string
  readonly contextId: string
  readonly attempt: number
  readonly inputKey: string
  readonly payload: SessionInputPayload
}) =>
  Activity.make({
    name: options.activityName,
    success: Schema.Void,
    execute: RuntimeContextSessionWorkflow.execute({
      contextId: options.contextId,
      attempt: options.attempt,
      inputKey: options.inputKey,
      input: options.payload,
    }, { discard: true }).pipe(Effect.asVoid),
  })

// ── PermissionRoundtripWorkflow ─────────────────────────────────────────────

export const PermissionRoundtripPayloadSchema = Schema.Struct({
  contextId: Schema.String,
  attempt: Schema.Number,
  permissionRequestId: Schema.String,
  toolUseId: Schema.String,
})
export type PermissionRoundtripPayload = Schema.Schema.Type<typeof PermissionRoundtripPayloadSchema>

export const PermissionDecisionSchema = Schema.Literal("allow", "deny", "cancelled")
export type PermissionDecision = Schema.Schema.Type<typeof PermissionDecisionSchema>

export const PermissionRoundtripResultSchema = Schema.Struct({
  permissionRequestId: Schema.String,
  decision: PermissionDecisionSchema,
})

// workflow-make-admission: see docs/workflow-make-admission-ledger.md
export const PermissionRoundtripWorkflow = Workflow.make({
  name: "unified.permission-roundtrip",
  payload: PermissionRoundtripPayloadSchema,
  success: PermissionRoundtripResultSchema,
  idempotencyKey: (p) => `${p.contextId}:${p.permissionRequestId}`,
})

export const PERMISSION_DECISION_SIGNAL = "permission-decision"

/** Payload shape the responder delivers via the DurableDeferred. */
export const PermissionDecisionPayloadSchema = Schema.Struct({
  decision: PermissionDecisionSchema,
})
export type PermissionDecisionPayload = Schema.Schema.Type<typeof PermissionDecisionPayloadSchema>

/**
 * The await-once durable completion the body parks on. tf-k00i: replaces the
 * bespoke `signal.ts` `awaitSignal`/`sendSignal` with `@effect/workflow`'s
 * `DurableDeferred`, which already rides `DurableStreamsWorkflowEngine`
 * (`deferredResult`/`deferredDone`). The responder
 * (`HostPermissionRespondChannel`) resolves it with the per-execution token.
 */
export const permissionDecisionDeferred = DurableDeferred.make(
  PERMISSION_DECISION_SIGNAL,
  { success: PermissionDecisionPayloadSchema },
)

const permissionRoundtripBody = (payload: PermissionRoundtripPayload) =>
  Effect.gen(function*() {
    const table = yield* UnifiedTable
    const key = permissionKey(payload.contextId, payload.permissionRequestId)

    // Activity-memoized: record the open-request row so the host UI
    // can render the pending decision. The row holds no lifecycle
    // status — the decision flows via the signal payload.
    yield* Activity.make({
      name: `unified.permission.request/${key}`,
      success: Schema.Void,
      execute: Clock.currentTimeMillis.pipe(
        Effect.flatMap((millis) =>
          table.permissions.insertOrGet({
            permissionKey: key,
            contextId: payload.contextId,
            permissionRequestId: payload.permissionRequestId,
            toolUseId: payload.toolUseId,
            requestedAt: new Date(millis).toISOString(),
          }),
        ),
        Effect.orDie,
        Effect.asVoid,
      ),
    })

    // Park until the responder resolves the decision DurableDeferred.
    const decisionPayload = yield* DurableDeferred.await(permissionDecisionDeferred)

    // Feedback: deliver the decision back to the session as a
    // `permission-response` input by executing a fresh per-event handler.
    // Auto-relay shape per SDD §E: payload is a Schema-encoded
    // AgentInputEvent (PermissionResponse variant). Maps the channel
    // decision strings ("allow"/"deny"/"cancelled") onto the typed
    // PermissionDecision discriminated union the codec expects.
    const decision: { readonly _tag: "Allow" } | { readonly _tag: "Deny" } | { readonly _tag: "Cancelled" } =
      decisionPayload.decision === "allow"
        ? { _tag: "Allow" }
        : decisionPayload.decision === "deny"
          ? { _tag: "Deny" }
          : { _tag: "Cancelled" }
    const permissionResponseEvent = {
      _tag: "PermissionResponse" as const,
      permissionRequestId: payload.permissionRequestId,
      decision,
    }
    const relayPayload: SessionInputPayload = {
      kind: "permission-response",
      payloadJson: encodeAgentInputEventJson(permissionResponseEvent),
    }
    yield* relaySessionInput({
      activityName: `unified.permission.relay/${key}`,
      contextId: payload.contextId,
      attempt: payload.attempt,
      inputKey: `permission-response:${payload.permissionRequestId}`,
      payload: relayPayload,
    })

    return {
      permissionRequestId: payload.permissionRequestId,
      decision: decisionPayload.decision,
    }
  }) as Effect.Effect<
    Schema.Schema.Type<typeof PermissionRoundtripResultSchema>,
    never,
    UnifiedTable | WorkflowEngine.WorkflowEngine
  >

export const buildPermissionRoundtripLayer = () =>
  PermissionRoundtripWorkflow.toLayer(permissionRoundtripBody)

// ── ToolDispatchWorkflow ────────────────────────────────────────────────────
//
// At-most-once via `Workflow.idempotencyKey` (one execution per toolUseId)
// + `Activity.make` memoization (one executor invocation per execution).
// No `toolResults` table — the engine activity record IS the durable
// result, and the workflow execution's `finalResult` is the durable
// return value.
//
// Phase 3 (SDD §D): after executing the tool, relay the result back to
// the originating session workflow as a `tool-result` input signal.

export const ToolDispatchPayloadSchema = Schema.Struct({
  contextId: Schema.String,
  attempt: Schema.Number,
  toolUseId: Schema.String,
  toolName: Schema.String,
  inputJson: Schema.String,
})
export type ToolDispatchPayload = Schema.Schema.Type<typeof ToolDispatchPayloadSchema>

export const ToolDispatchResultSchema = Schema.Struct({
  toolUseId: Schema.String,
  resultJson: Schema.String,
})

// workflow-make-admission: see docs/workflow-make-admission-ledger.md
export const ToolDispatchWorkflow = Workflow.make({
  name: "unified.tool-dispatch",
  payload: ToolDispatchPayloadSchema,
  success: ToolDispatchResultSchema,
  idempotencyKey: (p) => p.toolUseId,
})

export interface ToolExecutorState {
  /** Increments on each genuine executor invocation. Asserted == 1. */
  readonly invocationCount: Ref.Ref<number>
}

export interface ToolExecutor {
  readonly state: ToolExecutorState
  readonly execute: (
    payload: ToolDispatchPayload,
  ) => Effect.Effect<string>
}

export const makeToolExecutor = (
  resultFn: (payload: ToolDispatchPayload) => string,
): Effect.Effect<ToolExecutor> =>
  Effect.gen(function*() {
    const invocationCount = yield* Ref.make(0)
    return {
      state: { invocationCount },
      execute: (payload) =>
        Effect.gen(function*() {
          yield* Ref.update(invocationCount, (n) => n + 1)
          return resultFn(payload)
        }),
    }
  })

const toolDispatchBody = (executor: ToolExecutor) =>
  (payload: ToolDispatchPayload) =>
    Effect.gen(function*() {
      const resultJson = yield* Activity.make({
        name: `unified.tool.execute/${payload.toolUseId}`,
        success: Schema.String,
        execute: executor.execute(payload),
      })

      // Feedback: deliver tool result back to the session as a `tool-result`
      // input by executing a fresh per-event handler. Activity-memoized;
      // runs exactly once. Per SDD §D.
      // Auto-relay shape per SDD §D: payload is a Schema-encoded
      // AgentInputEvent (ToolResult variant) so the production codec
      // adapter can decode it back to a typed value and forward to
      // the codec's session.send. Wrapping the resultJson as the
      // `ToolResult.part.result` lets the agent receive structured
      // tool output that round-trips through the codec wire format.
      const result = yield* Schema.decode(Schema.parseJson())(resultJson).pipe(Effect.orDie)
      const toolResultEvent = {
        _tag: "ToolResult" as const,
        part: Prompt.toolResultPart({
          id: payload.toolUseId,
          name: payload.toolName,
          isFailure: false,
          providerExecuted: false,
          result,
        }),
      }
      const relayPayload: SessionInputPayload = {
        kind: "tool-result",
        payloadJson: encodeAgentInputEventJson(toolResultEvent),
      }
      yield* relaySessionInput({
        activityName: `unified.tool.relay/${payload.toolUseId}`,
        contextId: payload.contextId,
        attempt: payload.attempt,
        inputKey: `tool-result:${payload.toolUseId}`,
        payload: relayPayload,
      })

      return { toolUseId: payload.toolUseId, resultJson }
    }) as Effect.Effect<
      Schema.Schema.Type<typeof ToolDispatchResultSchema>,
      never,
      WorkflowEngine.WorkflowEngine
    >

export const buildToolDispatchLayer = (executor: ToolExecutor) =>
  ToolDispatchWorkflow.toLayer(toolDispatchBody(executor))
