/**
 * tf-c71h — per-event RuntimeContext WORKBENCH host.
 *
 * Goal (docs/analysis/2026-06-02-runtime-shape-blast-radius-and-prior-art.md §4):
 * gather trace evidence that the load-bearing RuntimeContext session loop can
 * adopt the PER-EVENT fresh-execution shape that `PermissionRoundtripWorkflow`
 * already runs in production — generalized to MANY inputs per `contextId`.
 *
 * The single production body that diverges from the actor/virtual-object model
 * is `subscribers/runtime-context.ts`'s `while (!reachedTerminal)` parked loop
 * (`Workflow.suspend`). This host composes the REAL `FiregridRuntime` factory
 * and OVERRIDES ONLY the inbound session-input channel bindings so each public
 * `session.prompt` / `session.close` routes to a NEW per-event handler workflow
 * (`workbench.per-event-runtime-context`). The factory's parked
 * `RuntimeContextSessionWorkflow` stays registered-but-DORMANT — the trace
 * proves it never executes.
 *
 * The per-event body mirrors `runtime-context.ts` MINUS the while/suspend loop:
 * a fresh execution per event reads a durable consume CURSOR (C1 keyed durable
 * state), reads exactly its own input row (O(1)), forwards to the REAL adapter,
 * advances the cursor, and RETURNS (run-to-completion). It is fresh-execution-
 * per-event over a durable cursor — NOT return-and-re-drive (a returned
 * execution cannot be re-armed; signal.ts:150 / engine resume no-ops a missing
 * execution, engine-runtime.ts:184).
 *
 * NO fake codec/adapter/sandbox/recorder and NO Tag-swap of the spawn path: the
 * fixture is the real ACP example agent process spawned through the production
 * `ProductionCodecAdapterLive` (composed via `defaultProductionAdapterLayer`),
 * exactly as `unified-kernel-validation` does.
 *
 * Adapter Tag note: the per-event body consumes the REAL
 * `RuntimeContextSessionAdapter` Tag, provided by the real
 * `defaultProductionAdapterLayer()` — never a stub. The eslint rule
 * `ImportSpecifier[imported.name='RuntimeContextSessionAdapter']` (host.ts
 * airgap) was written to block STUB adapter Lives; it also blocks a NAMED
 * import of the Tag for legitimate consumption, so we reach the same real Tag
 * through the `@firegrid/runtime/unified` namespace (`Unified.*`). This exercises
 * production code (no `Layer.succeed` over the adapter anywhere). See
 * docs/findings/tf-c71h-*.md §tooling.
 */

import { Prompt } from "@effect/ai"
import { Activity, Workflow, WorkflowEngine } from "@effect/workflow"
import {
  eventOffset,
  makeDurableEventChannel,
  HostPromptChannel,
  HostPromptChannelTarget,
  SessionCloseChannel,
  SessionCloseChannelTarget,
  SessionPromptChannel,
  SessionPromptChannelTarget,
} from "@firegrid/protocol/channels"
import {
  SessionCloseToolInputSchema,
} from "@firegrid/protocol/agent-tools"
import { PublicPromptRequestSchema } from "@firegrid/protocol/runtime-ingress"
import { SessionHandlePromptInputSchema } from "@firegrid/protocol/session-facade"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import {
  defaultProductionAdapterLayer,
  FiregridRuntime,
  HostSessionsStartChannelLive,
  SessionCancelChannelLive,
  SessionInputPayloadSchema,
  type SessionInputPayload,
} from "@firegrid/runtime/unified"
// Namespace access to the REAL `RuntimeContextSessionAdapter` Tag — see the
// adapter-Tag note in the module docblock above. We consume the production Tag;
// the real Live comes from `defaultProductionAdapterLayer()`.
import * as Unified from "@firegrid/runtime/unified"
import {
  AgentInputEventSchema,
  type AgentInputEvent,
} from "@firegrid/runtime/events"
import { DurableTable } from "effect-durable-operators"
import { Effect, Layer, Option, Schema } from "effect"
import type {
  FiregridHost,
  TinyFiregridHostEnv,
} from "../../types.ts"

const DEFAULT_ATTEMPT = 1

// ── Durable workbench tables ────────────────────────────────────────────────
//
// The per-event handler's keyed durable state (C1). Two real DurableTables on
// real durable streams: an append-only input log keyed `${contextId}:${seq}`,
// and a per-context consume cursor keyed `${contextId}`.

const InputLogRowSchema = Schema.Struct({
  inputLogKey: Schema.String.pipe(DurableTable.primaryKey),
  contextId: Schema.String,
  seq: Schema.Number,
  inputKey: Schema.String,
  kind: SessionInputPayloadSchema.fields.kind,
  payloadJson: Schema.String,
  recordedAt: Schema.String,
})

class InputLogTable extends DurableTable(
  "tiny.firegrid.perEventRuntimeContext.inputLog",
  { rows: InputLogRowSchema },
) {}

const CursorRowSchema = Schema.Struct({
  contextId: Schema.String.pipe(DurableTable.primaryKey),
  consumed: Schema.Number,
  updatedAt: Schema.String,
})

class CursorTable extends DurableTable(
  "tiny.firegrid.perEventRuntimeContext.cursor",
  { rows: CursorRowSchema },
) {}

// ── Per-event handler workflow ──────────────────────────────────────────────

const PerEventPayloadSchema = Schema.Struct({
  contextId: Schema.String,
  attempt: Schema.Number,
  inputKey: Schema.String,
  seq: Schema.Number,
})

const PerEventResultSchema = Schema.Struct({
  contextId: Schema.String,
  inputKey: Schema.String,
  seq: Schema.Number,
  kind: SessionInputPayloadSchema.fields.kind,
  consumedBefore: Schema.Number,
  advancedTo: Schema.Number,
  seqMatchedCursor: Schema.Boolean,
  reachedTerminal: Schema.Boolean,
})

const PerEventWorkflow = Workflow.make({
  name: "workbench.per-event-runtime-context",
  payload: PerEventPayloadSchema,
  success: PerEventResultSchema,
  idempotencyKey: (p) => `${p.contextId}:${p.inputKey}`,
})

const now = (): string => new Date().toISOString()

/**
 * The per-event body. Mirrors `runtime-context.ts` MINUS the while/suspend
 * loop: one fresh execution per event, reading a durable cursor + one input
 * row, forwarding to the real adapter, advancing the cursor, then RETURNING.
 */
const perEventBody = (
  payload: typeof PerEventPayloadSchema.Type,
) =>
  Effect.gen(function*() {
    const adapter = yield* Unified.RuntimeContextSessionAdapter
    const inputLog = yield* InputLogTable
    const cursor = yield* CursorTable
    const key = `${payload.contextId}:${payload.attempt}`

    // 1. Spawn once / no-op reattach. Activity-memoized — the engine activity
    //    record IS the durable spawn evidence (no parallel runs row). The same
    //    process serves later events for this contextId (multi-turn continuity,
    //    codec-adapter.ts:408).
    yield* Activity.make({
      name: `workbench.per-event.start_or_attach/${payload.contextId}`,
      success: Schema.Void,
      execute: adapter.startOrAttach(payload.contextId, payload.attempt).pipe(
        Effect.orDie,
      ),
    })

    // 2. Read the durable consume cursor (O(1)); default 0.
    const cursorRow = yield* cursor.rows.get(payload.contextId).pipe(Effect.orDie)
    const consumedBefore = Option.match(cursorRow, {
      onNone: () => 0,
      onSome: (row) => row.consumed,
    })

    // 3. Read exactly this event's input row (O(1)) — NOT the O(all signals)
    //    dense `readSignalsFor` rescan the parked body does (runtime-context.ts:114).
    const rowKey = `${payload.contextId}:${payload.seq}`
    const rowOption = yield* inputLog.rows.get(rowKey).pipe(Effect.orDie)
    const row = yield* Option.match(rowOption, {
      onNone: () => Effect.dieMessage(`missing input-log row ${rowKey}`),
      onSome: (value) => Effect.succeed(value),
    })

    // OBSERVE per-key ordering: is this event's seq the one the cursor expects?
    // Do NOT force it; annotate it so the trace carries the evidence.
    const seqMatchedCursor = payload.seq === consumedBefore
    const input: SessionInputPayload = {
      kind: row.kind,
      payloadJson: row.payloadJson,
    }

    yield* Effect.annotateCurrentSpan({
      "firegrid.workbench.context_id": payload.contextId,
      "firegrid.workbench.input_key": payload.inputKey,
      "firegrid.workbench.seq": payload.seq,
      "firegrid.workbench.cursor_consumed": consumedBefore,
      "firegrid.workbench.seq_matched_cursor": seqMatchedCursor,
      "firegrid.workbench.kind": row.kind,
    })

    if (row.kind === "terminal") {
      // Terminal cleanup: release the adapter's host-level process registry
      // entry (kills the process). Activity-memoized; runs exactly once.
      yield* Activity.make({
        name: `workbench.per-event.deregister/${payload.contextId}`,
        success: Schema.Void,
        execute: adapter.deregister(payload.contextId).pipe(Effect.orDie),
      })
      return {
        contextId: payload.contextId,
        inputKey: payload.inputKey,
        seq: payload.seq,
        kind: row.kind,
        consumedBefore,
        advancedTo: consumedBefore,
        seqMatchedCursor,
        reachedTerminal: true,
      }
    }

    // Forward to the real adapter. Activity-memoized per execution — so a
    // retried execution does NOT re-fire an already-delivered send (proof #3:
    // no double-send via Activity memoization).
    yield* Activity.make({
      name: `workbench.per-event.send/${key}/${payload.seq}`,
      success: Schema.Void,
      execute: adapter.send(payload.contextId, payload.attempt, input).pipe(
        Effect.orDie,
      ),
    })

    // Advance the durable cursor (Activity-memoized upsert). 0 -> 1 -> 2 ...
    const advancedTo = consumedBefore + 1
    yield* Activity.make({
      name: `workbench.per-event.advance_cursor/${payload.contextId}/${payload.seq}`,
      success: Schema.Void,
      execute: cursor.rows.upsert({
        contextId: payload.contextId,
        consumed: advancedTo,
        updatedAt: now(),
      }).pipe(Effect.orDie),
    })

    return {
      contextId: payload.contextId,
      inputKey: payload.inputKey,
      seq: payload.seq,
      kind: row.kind,
      consumedBefore,
      advancedTo,
      seqMatchedCursor,
      reachedTerminal: false,
    }
  }).pipe(
    Effect.withSpan("workbench.per_event.body", {
      kind: "consumer",
      attributes: {
        "firegrid.context.id": payload.contextId,
        "firegrid.workbench.attempt": payload.attempt,
      },
    }),
  )

// ── Per-event channel overrides ─────────────────────────────────────────────
//
// Each override writes the input to the durable log (seq = count of existing
// rows for the contextId), then `execute(..., { discard: true })`s a FRESH
// per-event handler execution (mirrors armSession's execute-with-discard,
// signal.ts:152) — never arming the parked body. The driver drives prompts
// sequentially, so seq assignment is deterministic; per-key serialization under
// concurrency is OBSERVED via the body's `seq_matched_cursor` attr, not forced.

const encodeAgentInputEvent = Schema.encodeSync(AgentInputEventSchema)

/**
 * Replicates channel-bindings.ts `encodePromptPayload`: encode a public prompt
 * into a `SessionInputPayload` whose `payloadJson` is a Schema-encoded
 * `AgentInputEvent` Prompt, so the REAL production codec adapter decodes it.
 */
const promptPayloadJson = (text: string, correlationId: string): string => {
  const event: AgentInputEvent = {
    _tag: "Prompt",
    prompt: Prompt.userMessage({ content: [Prompt.textPart({ text })] }),
    correlationId,
  }
  return JSON.stringify(encodeAgentInputEvent(event))
}

const promptText = (payload: unknown): string =>
  typeof payload === "object"
    && payload !== null
    && "text" in payload
    && typeof (payload as { readonly text: unknown }).text === "string"
    ? (payload as { readonly text: string }).text
    : JSON.stringify(payload)

const nextSeq = (
  inputLog: InputLogTable["Type"],
  contextId: string,
): Effect.Effect<number> =>
  inputLog.rows.query((coll) =>
    coll.toArray.filter((row) => row.contextId === contextId).length,
  ).pipe(Effect.orDie)

const writeAndExecute = (options: {
  readonly engine: WorkflowEngine.WorkflowEngine["Type"]
  readonly inputLog: InputLogTable["Type"]
  readonly contextId: string
  readonly inputKey: string
  readonly kind: SessionInputPayload["kind"]
  readonly payloadJson: string
  readonly target: string
}) =>
  Effect.gen(function*() {
    const seq = yield* nextSeq(options.inputLog, options.contextId)
    yield* options.inputLog.rows.insertOrGet({
      inputLogKey: `${options.contextId}:${seq}`,
      contextId: options.contextId,
      seq,
      inputKey: options.inputKey,
      kind: options.kind,
      payloadJson: options.payloadJson,
      recordedAt: now(),
    }).pipe(Effect.orDie)
    yield* PerEventWorkflow.execute({
      contextId: options.contextId,
      attempt: DEFAULT_ATTEMPT,
      inputKey: options.inputKey,
      seq,
    }, { discard: true })
    return eventOffset(`${options.target}:${options.contextId}:${seq}`)
  }).pipe(
    Effect.provideService(WorkflowEngine.WorkflowEngine, options.engine),
  )

const SessionPromptChannelPerEventLive = Layer.effect(
  SessionPromptChannel,
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine
    const inputLog = yield* InputLogTable
    return SessionPromptChannel.of({
      forSession: (sessionId) =>
        makeDurableEventChannel({
          target: SessionPromptChannelTarget,
          schema: SessionHandlePromptInputSchema,
          append: (request) =>
            writeAndExecute({
              engine,
              inputLog,
              contextId: sessionId,
              inputKey: request.idempotencyKey,
              kind: "prompt",
              payloadJson: promptPayloadJson(
                promptText(request.payload),
                request.idempotencyKey,
              ),
              target: String(SessionPromptChannelTarget),
            }),
        }),
    })
  }),
)

const HostPromptChannelPerEventLive = Layer.effect(
  HostPromptChannel,
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine
    const inputLog = yield* InputLogTable
    return makeDurableEventChannel({
      target: HostPromptChannelTarget,
      schema: PublicPromptRequestSchema,
      append: (request) => {
        const correlationId = request.idempotencyKey
          ?? `prompt-${request.contextId}`
        return writeAndExecute({
          engine,
          inputLog,
          contextId: request.contextId,
          inputKey: correlationId,
          kind: "prompt",
          payloadJson: promptPayloadJson(
            promptText(request.payload),
            correlationId,
          ),
          target: String(HostPromptChannelTarget),
        })
      },
    })
  }),
)

const SessionCloseChannelPerEventLive = Layer.effect(
  SessionCloseChannel,
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine
    const inputLog = yield* InputLogTable
    return makeDurableEventChannel({
      target: SessionCloseChannelTarget,
      schema: SessionCloseToolInputSchema,
      append: (request) =>
        writeAndExecute({
          engine,
          inputLog,
          contextId: request.sessionId,
          inputKey: `terminal:${request.sessionId}`,
          kind: "terminal",
          payloadJson: JSON.stringify({
            operation: "close",
            ...(request.reason === undefined ? {} : { reason: request.reason }),
          }),
          target: String(SessionCloseChannelTarget),
        }),
    })
  }),
)

// ── Host composition ────────────────────────────────────────────────────────

const workbenchTablesLayer = (env: TinyFiregridHostEnv) =>
  Layer.merge(
    InputLogTable.layer({
      streamOptions: {
        url: durableStreamUrl(
          env.durableStreamsBaseUrl,
          `${env.namespace}.workbench.per-event.input-log`,
        ),
        contentType: "application/json",
      },
    }),
    CursorTable.layer({
      streamOptions: {
        url: durableStreamUrl(
          env.durableStreamsBaseUrl,
          `${env.namespace}.workbench.per-event.cursor`,
        ),
        contentType: "application/json",
      },
    }),
  )

export const perEventRuntimeContextHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown> => {
  const tables = workbenchTablesLayer(env)

  // The per-event handler body's REAL adapter — a second production-codec
  // adapter instance (the factory's own adapter drives only the dormant body,
  // which never executes). One real spawn path; no stub.
  const adapter = defaultProductionAdapterLayer()

  const workflowLayer = PerEventWorkflow.toLayer(perEventBody)

  const channelOverrides = Layer.mergeAll(
    SessionPromptChannelPerEventLive,
    HostPromptChannelPerEventLive,
    SessionCloseChannelPerEventLive,
    // Exported production STUB channel Lives: start/cancel return a stable
    // offset and do NOT arm the parked body (keeps it dormant).
    HostSessionsStartChannelLive,
    SessionCancelChannelLive,
  )

  // Provide the real adapter + workbench tables into the per-event handler and
  // channel overrides. WorkflowEngine + the adapter's substrate inputs
  // (RuntimeControlPlaneTable / RuntimeOutputTable / FiregridRuntimeContextMcpBaseUrl)
  // remain inputs, satisfied by the real factory below.
  const overrides = Layer.mergeAll(workflowLayer, channelOverrides).pipe(
    Layer.provideMerge(adapter),
    Layer.provideMerge(tables),
  )

  const factory = FiregridRuntime(
    {
      durableStreamsBaseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
    },
    defaultProductionAdapterLayer(),
  )

  // OUTER (override) layer wins for duplicate output Tags — verified: the
  // override channel Lives replace the factory's `UnifiedSignalingChannelBindings`
  // for session.prompt / host.prompt / session.close / host.sessions.start /
  // session.cancel. host.permissions.respond is left as the factory's
  // production binding (the permission OBSERVER path stays untouched).
  return overrides.pipe(Layer.provideMerge(factory))
}
