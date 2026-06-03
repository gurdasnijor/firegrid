/**
 * Unified channel bindings.
 *
 * Provides the channel `Context.Tag` services that `Firegrid` resolves
 * at composition time, backed by the unified signal/table primitives.
 * Production hosts may override individual Tags with custom Lives
 * upstream; the bindings here are the canonical default for
 * standalone consumers.
 *
 * Per SDD_FIREGRID_PROTOCOL_RESPONSE_UNIFICATION phase 2: the four
 * input-delivery channels (`host.prompt`, `session.prompt`,
 * `host.sessions.start`, `host.permissions.respond`) are
 * `DurableEventChannel<P>` returning `EventOffset`. The
 * derivation/snapshot/ingress channels (`host.contexts.create`,
 * `host.sessions.create_or_load`, `host.contexts`,
 * `host.context.snapshot`, `host.session.snapshot`,
 * `session.lifecycle`) keep their semantic shapes.
 */

import {
  HostContextsCreateRequestSchema,
  HostPermissionRespondChannel,
  HostPermissionRespondChannelRequestSchema,
  HostPermissionRespondChannelTarget,
  HostPromptChannel,
  HostPromptChannelTarget,
  HostSessionsCreateOrLoadRequestSchema,
  HostSessionsStartChannel,
  HostSessionsStartChannelTarget,
  HostSessionsStartRequestSchema,
  SessionCancelChannel,
  SessionCancelChannelTarget,
  SessionCloseChannel,
  SessionCloseChannelTarget,
  SessionPromptChannel,
  SessionPromptChannelTarget,
  eventOffset,
  makeDurableEventChannel,
} from "@firegrid/protocol/channels"
import { Prompt } from "@effect/ai"
import { DurableDeferred, WorkflowEngine } from "@effect/workflow"
import { Clock, Effect, Layer, Schema } from "effect"
import {
  SessionCancelToolInputSchema,
  SessionCloseToolInputSchema,
  type SessionCancelToolInput,
  type SessionCloseToolInput,
} from "@firegrid/protocol/agent-tools"
import {
  AgentInputEventSchema,
  type AgentInputEvent,
} from "../events/contract.ts"
import { type SessionInputPayload } from "./adapter.ts"
import {
  RuntimeContextSessionWorkflow,
} from "./subscribers/runtime-context.ts"

const stableOffset = (target: string, key: string) =>
  Effect.succeed(eventOffset(`${target}:${key}`))

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

/**
 * Stub `HostPromptChannel` — returns a stable offset without signaling.
 * Satisfies the Tag for consumers (`FiregridLive.make`) that resolve it
 * eagerly but never actually invoke it. Production hosts override with
 * `HostPromptChannelSignalingLive` (below) which actually delivers the
 * prompt signal to the session workflow body.
 */
export const HostPromptChannelLive = Layer.succeed(
  HostPromptChannel,
  makeDurableEventChannel({
    target: HostPromptChannelTarget,
    schema: HostContextsCreateRequestSchema as never,
    append: (request) =>
      stableOffset(
        String(HostPromptChannelTarget),
        `${(request as { contextId?: string }).contextId ?? ""}:${(request as { idempotencyKey?: string }).idempotencyKey ?? ""}`,
      ),
  }) as unknown as HostPromptChannel["Type"],
)

/**
 * Stub `SessionPromptChannel.forSession` — returns a stable offset.
 * Override with `SessionPromptChannelSignalingLive` for production.
 */
export const SessionPromptChannelLive = Layer.succeed(
  SessionPromptChannel,
  SessionPromptChannel.of({
    forSession: (sessionId) =>
      makeDurableEventChannel({
        target: SessionPromptChannelTarget,
        schema: HostSessionsCreateOrLoadRequestSchema as never,
        append: (request) =>
          stableOffset(
            String(SessionPromptChannelTarget),
            `${sessionId}:${(request as { idempotencyKey?: string }).idempotencyKey ?? ""}`,
          ),
      }) as unknown as ReturnType<SessionPromptChannel["Type"]["forSession"]>,
  }),
)

/**
 * Stub `HostSessionsStartChannel` — returns a stable offset.
 * Override with `HostSessionsStartChannelSignalingLive` for production.
 */
export const HostSessionsStartChannelLive = Layer.succeed(
  HostSessionsStartChannel,
  makeDurableEventChannel({
    target: HostSessionsStartChannelTarget,
    schema: HostSessionsStartRequestSchema,
    append: (request) =>
      stableOffset(String(HostSessionsStartChannelTarget), request.sessionId),
  }),
)

/**
 * Stub `SessionCancelChannel` — returns a stable offset.
 * Override with `SessionCancelChannelSignalingLive` for production.
 */
export const SessionCancelChannelLive = Layer.succeed(
  SessionCancelChannel,
  makeDurableEventChannel({
    target: SessionCancelChannelTarget,
    schema: SessionCancelToolInputSchema,
    append: (request) =>
      stableOffset(String(SessionCancelChannelTarget), request.sessionId),
  }),
)

/**
 * Stub `SessionCloseChannel` — returns a stable offset.
 * Override with `SessionCloseChannelSignalingLive` for production.
 */
export const SessionCloseChannelLive = Layer.succeed(
  SessionCloseChannel,
  makeDurableEventChannel({
    target: SessionCloseChannelTarget,
    schema: SessionCloseToolInputSchema,
    append: (request) =>
      stableOffset(String(SessionCloseChannelTarget), request.sessionId),
  }),
)

/**
 * Stub `HostPermissionRespondChannel`. Override with the signaling
 * version for production.
 */
export const HostPermissionRespondChannelLive = Layer.succeed(
  HostPermissionRespondChannel,
  makeDurableEventChannel({
    target: HostPermissionRespondChannelTarget,
    schema: HostPermissionRespondChannelRequestSchema,
    append: (request) =>
      stableOffset(
        String(HostPermissionRespondChannelTarget),
        `${request.contextId}:${request.permissionRequestId}`,
      ),
  }),
)

// ── Production signaling overrides ─────────────────────────────────────────
//
// These Lives REPLACE the stub Lives above for production hosts. They
// require `SignalTable` + `WorkflowEngine` (provided by FiregridHost's
// substrate) and actually deliver signals to the unified workflow bodies.

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

const terminalPayloadJson = (
  operation: "cancel" | "close",
  reason: string | undefined,
): string => JSON.stringify({
  operation,
  ...(reason === undefined ? {} : { reason }),
})

const signalSessionTerminal = (options: {
  readonly engine: WorkflowEngine.WorkflowEngine["Type"]
  readonly operation: "cancel" | "close"
  readonly request: SessionCancelToolInput | SessionCloseToolInput
  readonly target: string
}) =>
  Effect.gen(function*() {
    const executionId = yield* emitSessionTerminalSignal({
      engine: options.engine,
      contextId: options.request.sessionId,
      idempotencyKey: `session.${options.operation}:${options.request.sessionId}`,
      payloadJson: terminalPayloadJson(options.operation, options.request.reason),
    })
    return eventOffset(`${options.target}:${executionId}`)
  }).pipe(
    Effect.withSpan(`firegrid.unified.session.${options.operation}`, {
      kind: "producer",
      attributes: {
        "firegrid.channel.target": options.target,
        "firegrid.context.id": options.request.sessionId,
        "firegrid.session.id": options.request.sessionId,
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

/** Production SessionCancelChannel — executes a terminal per-event handler. */
export const SessionCancelChannelSignalingLive = Layer.effect(
  SessionCancelChannel,
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine
    return makeDurableEventChannel({
      target: SessionCancelChannelTarget,
      schema: SessionCancelToolInputSchema,
      append: (request) =>
        signalSessionTerminal({
          engine,
          operation: "cancel",
          request,
          target: String(SessionCancelChannelTarget),
        }),
    })
  }),
)

/** Production SessionCloseChannel — executes a terminal per-event handler. */
export const SessionCloseChannelSignalingLive = Layer.effect(
  SessionCloseChannel,
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine
    return makeDurableEventChannel({
      target: SessionCloseChannelTarget,
      schema: SessionCloseToolInputSchema,
      append: (request) =>
        signalSessionTerminal({
          engine,
          operation: "close",
          request,
          target: String(SessionCloseChannelTarget),
        }),
    })
  }),
)

/**
 * Production HostPermissionRespondChannel — resolves the
 * PermissionRoundtripWorkflow's decision `DurableDeferred` for the matching
 * execution (tf-k00i: replaces `sendSignal`).
 *
 * Note: `toolUseId` is best-effort here. The roundtrip workflow's
 * `idempotencyKey` is `(contextId, permissionRequestId)` so the executionId is
 * deterministic across both the observer-triggered and respond call sites.
 */
export const HostPermissionRespondChannelSignalingLive = Layer.effect(
  HostPermissionRespondChannel,
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine
    const { PermissionRoundtripWorkflow, permissionDecisionDeferred } =
      yield* Effect.promise(() => import("./subscribers/permission-and-tool.ts"))
    return makeDurableEventChannel({
      target: HostPermissionRespondChannelTarget,
      schema: HostPermissionRespondChannelRequestSchema,
      append: (request) => {
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
        }).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine))
      },
    })
  }),
)

/**
 * Production signaling channel bindings — `FiregridHost` provides this
 * on top of the stub `UnifiedChannelBindingsLive` so the four
 * input-delivery channels actually wire to signals. Requires
 * `SignalTable` + `WorkflowEngine` from the substrate.
 */
export const UnifiedSignalingChannelBindingsLive = HostPromptChannelSignalingLive.pipe(
  Layer.provideMerge(SessionPromptChannelSignalingLive),
  // session.start has no parked body to arm (tf-k00i): reuse the no-op stub.
  Layer.provideMerge(HostSessionsStartChannelLive),
  Layer.provideMerge(SessionCancelChannelSignalingLive),
  Layer.provideMerge(SessionCloseChannelSignalingLive),
  Layer.provideMerge(HostPermissionRespondChannelSignalingLive),
)

export const UnifiedChannelBindingsLive = HostPromptChannelLive.pipe(
  Layer.provideMerge(SessionPromptChannelLive),
  Layer.provideMerge(HostSessionsStartChannelLive),
  Layer.provideMerge(SessionCancelChannelLive),
  Layer.provideMerge(SessionCloseChannelLive),
  Layer.provideMerge(HostPermissionRespondChannelLive),
)
