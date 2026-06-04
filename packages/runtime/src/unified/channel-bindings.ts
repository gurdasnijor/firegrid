/**
 * Unified channel bindings.
 *
 * Provides the channel `Context.Tag` services that `Firegrid` resolves
 * at composition time, backed by the unified signal/table primitives.
 * Production hosts may override individual Tags with custom Lives
 * upstream; the bindings here are the canonical default for
 * standalone consumers.
 *
 * Per SDD_FIREGRID_PROTOCOL_RESPONSE_UNIFICATION phase 2: the input-delivery
 * channels (`host.prompt`, `session.prompt`, `host.permissions.respond`) are
 * `DurableEventChannel<P>` returning `EventOffset`. tf-vqv5: the terminal
 * (`session.cancel`/`session.close`) and `host.sessions.start` Tags were
 * collapsed — their bindings were thin wrappers over `emitSessionTerminalSignal`
 * / a no-op ack, so consumers now call the durable op directly.
 */

import {
  HostContextsCreateRequestSchema,
  HostPermissionRespondChannelTarget,
  type HostPermissionRespondChannelRequest,
  HostPromptChannel,
  HostPromptChannelTarget,
  HostSessionsCreateOrLoadRequestSchema,
  SessionPromptChannel,
  SessionPromptChannelTarget,
  eventOffset,
  makeDurableEventChannel,
} from "@firegrid/protocol/channels"
import { Prompt } from "@effect/ai"
import { DurableDeferred, WorkflowEngine } from "@effect/workflow"
import { Clock, Effect, Layer, Schema } from "effect"
import {
  AgentInputEventSchema,
  type AgentInputEvent,
} from "../events/contract.ts"
import { type SessionInputPayload } from "./adapter.ts"
import {
  RuntimeContextSessionWorkflow,
} from "./subscribers/runtime-context.ts"
import {
  PermissionRoundtripWorkflow,
  permissionDecisionDeferred,
} from "./subscribers/permission-and-tool.ts"

const encodeAgentInputEvent = Schema.encodeSync(AgentInputEventSchema)

// Default session attempt for top-level firegrid.prompt / session.prompt
// calls. Multi-attempt sessions (the rare case where a session has been
// restarted) are addressed by callers using the channel router directly
// with the explicit attempt.
const DEFAULT_ATTEMPT = 1

/**
 * Encode a public prompt payload into a SessionInputPayload envelope
 * (kind="prompt", payloadJson = Schema-encoded AgentInputEvent). The
 * production codec adapter Schema-decodes this back to a typed
 * AgentInputEvent when calling session.send.
 */
const encodePromptPayload = (
  payload: { readonly text?: string; readonly idempotencyKey?: string },
  correlationIdFallback: string,
): SessionInputPayload => {
  const text = typeof payload === "object" && payload !== null && "text" in payload
    && typeof payload.text === "string"
    ? payload.text
    : JSON.stringify(payload)
  const event: AgentInputEvent = {
    _tag: "Prompt",
    prompt: Prompt.userMessage({
      content: [Prompt.textPart({ text })],
    }),
    correlationId: payload.idempotencyKey ?? correlationIdFallback,
  }
  return {
    kind: "prompt",
    payloadJson: JSON.stringify(encodeAgentInputEvent(event)),
  }
}

/**
 * Deliver one session input by EXECUTING a fresh per-event RuntimeContext
 * handler (Effect-native `Workflow.execute({discard})`, keyed `(contextId,
 * inputKey)`). tf-k00i: replaces `writeSessionInputSignal` (sendSignal + arm to
 * the parked body). `execute({discard:true})` creates the execution (the
 * input-before-start "arm") and returns its executionId.
 */
const executeSessionInput = (options: {
  readonly engine: WorkflowEngine.WorkflowEngine["Type"]
  readonly contextId: string
  readonly inputKey: string
  readonly input: SessionInputPayload
}): Effect.Effect<string> =>
  RuntimeContextSessionWorkflow.execute({
    contextId: options.contextId,
    attempt: DEFAULT_ATTEMPT,
    inputKey: options.inputKey,
    input: options.input,
  }, { discard: true }).pipe(
    Effect.provideService(WorkflowEngine.WorkflowEngine, options.engine),
  )

// ── Production signaling overrides ─────────────────────────────────────────
//
// These Lives require `WorkflowEngine` (provided by FiregridHost's substrate)
// and actually execute the per-event workflow bodies.

const signalPromptToSession = (options: {
  readonly engine: WorkflowEngine.WorkflowEngine["Type"]
  readonly contextId: string
  readonly payload: unknown
  readonly target: string
  readonly idempotencyKey?: string
}) =>
  Effect.gen(function*() {
    const correlationId = options.idempotencyKey
      ?? `prompt-${options.contextId}-${yield* Clock.currentTimeMillis}`
    const payload = encodePromptPayload(
      options.payload as { readonly text?: string },
      correlationId,
    )
    const executionId = yield* executeSessionInput({
      engine: options.engine,
      contextId: options.contextId,
      inputKey: correlationId,
      input: payload,
    })
    return eventOffset(`${options.target}:${executionId}|${correlationId}`)
  })

export const emitSessionTerminalSignal = (options: {
  readonly engine: WorkflowEngine.WorkflowEngine["Type"]
  readonly contextId: string
  readonly idempotencyKey: string
  readonly payloadJson?: string
}) =>
  executeSessionInput({
    engine: options.engine,
    contextId: options.contextId,
    inputKey: options.idempotencyKey,
    input: { kind: "terminal", payloadJson: options.payloadJson ?? "{}" },
  }).pipe(
    Effect.withSpan("firegrid.unified.session.terminal_signal", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": options.contextId,
        "firegrid.input.idempotency_key": options.idempotencyKey,
      },
    }),
  )

/** Production HostPromptChannel — executes a per-event session handler. */
export const HostPromptChannelSignalingLive = Layer.effect(
  HostPromptChannel,
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine
    return makeDurableEventChannel({
      target: HostPromptChannelTarget,
      schema: HostContextsCreateRequestSchema as never,
      append: (request) => {
        const req = request as {
          readonly contextId: string
          readonly payload: unknown
          readonly idempotencyKey?: string
        }
        return signalPromptToSession({
          engine,
          contextId: req.contextId,
          payload: req.payload,
          target: String(HostPromptChannelTarget),
          ...(req.idempotencyKey === undefined ? {} : { idempotencyKey: req.idempotencyKey }),
        })
      },
    })
  }),
)

/** Production SessionPromptChannel — executes a per-event session handler. */
export const SessionPromptChannelSignalingLive = Layer.effect(
  SessionPromptChannel,
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine
    return SessionPromptChannel.of({
      forSession: (sessionId) =>
        makeDurableEventChannel({
          target: SessionPromptChannelTarget,
          schema: HostSessionsCreateOrLoadRequestSchema as never,
          append: (request) => {
            const req = request as {
              readonly payload: unknown
              readonly idempotencyKey?: string
            }
            return signalPromptToSession({
              engine,
              contextId: sessionId,
              payload: req.payload,
              target: String(SessionPromptChannelTarget),
              ...(req.idempotencyKey === undefined ? {} : { idempotencyKey: req.idempotencyKey }),
            })
          },
        }),
    })
  }),
)

/**
 * Resolve a permission decision by completing the `PermissionRoundtripWorkflow`'s
 * decision `DurableDeferred` for the matching execution (tf-k00i: replaces
 * `sendSignal`). tf-vqv5: the durable op DIRECTLY — no `HostPermissionRespondChannel`
 * Tag; the binding was a thin wrapper over this. Backed by `WorkflowEngine` only
 * (no DurableTable), so callers resolve the engine themselves.
 *
 * Note: `toolUseId` is best-effort here. The roundtrip workflow's
 * `idempotencyKey` is `(contextId, permissionRequestId)` so the executionId is
 * deterministic across both the observer-triggered and respond call sites.
 */
export const respondPermissionDecision = (options: {
  readonly engine: WorkflowEngine.WorkflowEngine["Type"]
  readonly request: HostPermissionRespondChannelRequest
}) => {
  const { request } = options
  const decision: "allow" | "deny" | "cancelled" = request.decision._tag === "Allow"
    ? "allow"
    : request.decision._tag === "Deny"
      ? "deny"
      : "cancelled"
  return Effect.gen(function*() {
    const executionId = yield* PermissionRoundtripWorkflow.executionId({
      contextId: request.contextId,
      attempt: DEFAULT_ATTEMPT,
      permissionRequestId: request.permissionRequestId,
      toolUseId: `tool-${request.permissionRequestId}`,
    })
    const token = DurableDeferred.tokenFromExecutionId(permissionDecisionDeferred, {
      workflow: PermissionRoundtripWorkflow,
      executionId,
    })
    yield* DurableDeferred.succeed(permissionDecisionDeferred, {
      token,
      value: { decision },
    }).pipe(Effect.orDie)
    return eventOffset(
      `${String(HostPermissionRespondChannelTarget)}:${request.contextId}:${request.permissionRequestId}`,
    )
  }).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, options.engine))
}

/**
 * Production signaling channel bindings. Requires `WorkflowEngine` from the
 * substrate. tf-vqv5: permission-respond collapsed to `respondPermissionDecision`
 * (called directly by its consumers), so only the prompt channels remain as Tags.
 */
export const UnifiedSignalingChannelBindingsLive = HostPromptChannelSignalingLive.pipe(
  Layer.provideMerge(SessionPromptChannelSignalingLive),
)
