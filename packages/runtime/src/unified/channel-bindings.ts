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
  HostContextsChannel,
  HostContextsChannelTarget,
  HostContextsCreateChannel,
  HostContextsCreateChannelTarget,
  HostContextsCreateRequestSchema,
  HostContextsCreateResponseSchema,
  HostContextSnapshotChannel,
  HostContextSnapshotChannelTarget,
  HostContextSnapshotRequestSchema,
  HostPermissionRespondChannel,
  HostPermissionRespondChannelRequestSchema,
  HostPermissionRespondChannelTarget,
  HostPromptChannel,
  HostPromptChannelTarget,
  HostSessionsCreateOrLoadChannel,
  HostSessionsCreateOrLoadChannelTarget,
  HostSessionsCreateOrLoadRequestSchema,
  HostSessionsCreateOrLoadResponseSchema,
  HostSessionsStartChannel,
  HostSessionsStartChannelTarget,
  HostSessionsStartRequestSchema,
  HostSessionSnapshotChannel,
  HostSessionSnapshotChannelTarget,
  HostSessionSnapshotRequestSchema,
  RuntimeContextSnapshotSchema,
  SessionLifecycleChannel,
  SessionLifecycleChannelTarget,
  SessionPromptChannel,
  SessionPromptChannelTarget,
  eventOffset,
  makeCallableChannel,
  makeDurableEventChannel,
  makeIngressChannel,
} from "@firegrid/protocol/channels"
import { Prompt } from "@effect/ai"
import { WorkflowEngine } from "@effect/workflow"
import {
  RuntimeContextSchema,
  RuntimeControlPlaneTable,
  RuntimeRunEventSchema,
  CurrentHostSession,
} from "@firegrid/protocol/launch"
import { Clock, Effect, Layer, Schema, Stream } from "effect"
import {
  AgentInputEventSchema,
  type AgentInputEvent,
} from "../events/contract.ts"
import {
  type SessionInputPayload,
} from "./adapter.ts"
import { sendSignal, SignalTable } from "./signal.ts"
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

const encodePermissionResponsePayload = (
  permissionRequestId: string,
  decision: "allow" | "deny" | "cancelled",
): SessionInputPayload => {
  const decisionTag: { readonly _tag: "Allow" } | { readonly _tag: "Deny" } | { readonly _tag: "Cancelled" } =
    decision === "allow" ? { _tag: "Allow" } : decision === "deny" ? { _tag: "Deny" } : { _tag: "Cancelled" }
  const event = {
    _tag: "PermissionResponse" as const,
    permissionRequestId,
    decision: decisionTag,
  }
  return {
    kind: "permission-response",
    payloadJson: JSON.stringify(encodeAgentInputEvent(event as never)),
  }
}

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

/** Production HostPromptChannel — signals the session workflow. */
export const HostPromptChannelSignalingLive = Layer.effect(
  HostPromptChannel,
  Effect.gen(function*() {
    const signals = yield* SignalTable
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
        const correlationId = req.idempotencyKey ?? `prompt-${req.contextId}-${Date.now()}`
        const payload = encodePromptPayload(
          req.payload as { readonly text?: string },
          correlationId,
        )
        return Effect.gen(function*() {
          const executionId = yield* RuntimeContextSessionWorkflow.executionId({
            contextId: req.contextId,
            attempt: DEFAULT_ATTEMPT,
          })
          yield* sendSignal({
            signals,
            workflow: RuntimeContextSessionWorkflow,
            executionId,
            name: correlationId,
            write: () => Effect.void,
            value: payload,
            serializeValue: (v) => JSON.stringify(v),
          }).pipe(Effect.orDie)
          return eventOffset(`${String(HostPromptChannelTarget)}:${executionId}|${correlationId}`)
        }).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine))
      },
    }) as unknown as HostPromptChannel["Type"]
  }),
)

/** Production SessionPromptChannel — signals the session workflow. */
export const SessionPromptChannelSignalingLive = Layer.effect(
  SessionPromptChannel,
  Effect.gen(function*() {
    const signals = yield* SignalTable
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
            const correlationId = req.idempotencyKey ?? `prompt-${sessionId}-${Date.now()}`
            const payload = encodePromptPayload(
              req.payload as { readonly text?: string },
              correlationId,
            )
            return Effect.gen(function*() {
              const executionId = yield* RuntimeContextSessionWorkflow.executionId({
                contextId: sessionId,
                attempt: DEFAULT_ATTEMPT,
              })
              yield* sendSignal({
                signals,
                workflow: RuntimeContextSessionWorkflow,
                executionId,
                name: correlationId,
                write: () => Effect.void,
                value: payload,
                serializeValue: (v) => JSON.stringify(v),
              }).pipe(Effect.orDie)
              return eventOffset(`${String(SessionPromptChannelTarget)}:${executionId}|${correlationId}`)
            }).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine))
          },
        }) as unknown as ReturnType<SessionPromptChannel["Type"]["forSession"]>,
    })
  }),
)

/** Production HostSessionsStartChannel — forks the session workflow. */
export const HostSessionsStartChannelSignalingLive = Layer.effect(
  HostSessionsStartChannel,
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine
    return makeDurableEventChannel({
      target: HostSessionsStartChannelTarget,
      schema: HostSessionsStartRequestSchema,
      append: (request) =>
        Effect.gen(function*() {
          yield* Effect.fork(
            RuntimeContextSessionWorkflow.execute({
              contextId: request.sessionId,
              attempt: DEFAULT_ATTEMPT,
            }),
          )
          return eventOffset(`${String(HostSessionsStartChannelTarget)}:${request.sessionId}`)
        }).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine)),
    })
  }),
)

/**
 * Production HostPermissionRespondChannel — signals the
 * PermissionRoundtripWorkflow for the matching execution.
 *
 * Note: `toolUseId` is best-effort here. The roundtrip workflow's
 * `idempotencyKey` is `(contextId, permissionRequestId)` so the
 * executionId collision is correct even when the toolUseId guess
 * doesn't match the observer-triggered version — `executionId` is
 * deterministic across both call sites.
 */
export const HostPermissionRespondChannelSignalingLive = Layer.effect(
  HostPermissionRespondChannel,
  Effect.gen(function*() {
    const signals = yield* SignalTable
    const engine = yield* WorkflowEngine.WorkflowEngine
    const { PermissionRoundtripWorkflow, PERMISSION_DECISION_SIGNAL } =
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
          yield* sendSignal({
            signals,
            workflow: PermissionRoundtripWorkflow,
            executionId,
            name: PERMISSION_DECISION_SIGNAL,
            write: () => Effect.void,
            value: { decision },
            serializeValue: (v) => JSON.stringify(v),
          }).pipe(Effect.orDie)
          void encodePermissionResponsePayload // exported but unused here
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
export const UnifiedSignalingChannelBindingsLive = Layer.mergeAll(
  HostPromptChannelSignalingLive,
  SessionPromptChannelSignalingLive,
  HostSessionsStartChannelSignalingLive,
  HostPermissionRespondChannelSignalingLive,
)

/**
 * Persists context rows to `RuntimeControlPlaneTable.contexts` so the
 * codec adapter's context resolver (`ContextResolverFromControlPlaneTableLive`)
 * finds them at startOrAttach time. Requires `CurrentHostSession` so
 * the row's host binding (`hostId`, `streamPrefix`, `boundAtMs`)
 * carries valid wire-form values; `FiregridHost` provides the host
 * session via `buildCurrentHostSessionLayer`.
 */
export const HostContextsCreateChannelLive = Layer.effect(
  HostContextsCreateChannel,
  Effect.gen(function*() {
    const control = yield* RuntimeControlPlaneTable
    const hostSession = yield* CurrentHostSession
    return makeCallableChannel({
      target: HostContextsCreateChannelTarget,
      requestSchema: HostContextsCreateRequestSchema,
      responseSchema: HostContextsCreateResponseSchema,
      call: (request) =>
        Effect.gen(function*() {
          const nowMs = yield* Clock.currentTimeMillis
          yield* control.contexts.insertOrGet({
            contextId: request.contextId,
            createdAt: new Date(nowMs).toISOString(),
            ...(request.createdBy === undefined ? {} : { createdBy: request.createdBy }),
            runtime: {
              provider: request.runtime.provider,
              config: request.runtime.config,
              journal: [],
            },
            host: {
              hostId: hostSession.hostId,
              streamPrefix: hostSession.streamPrefix,
              boundAtMs: nowMs,
            },
          }).pipe(Effect.orDie, Effect.asVoid)
          return {
            sessionId: request.contextId,
            contextId: request.contextId,
          } as unknown as typeof HostContextsCreateResponseSchema.Type
        }),
    })
  }),
)

export const HostSessionsCreateOrLoadChannelLive = Layer.succeed(
  HostSessionsCreateOrLoadChannel,
  makeCallableChannel({
    target: HostSessionsCreateOrLoadChannelTarget,
    requestSchema: HostSessionsCreateOrLoadRequestSchema,
    responseSchema: HostSessionsCreateOrLoadResponseSchema,
    call: (request) => {
      const id = `session:${request.externalKey.source}:${request.externalKey.id}`
      return Effect.succeed({
        sessionId: id,
        contextId: id,
      } as unknown as typeof HostSessionsCreateOrLoadResponseSchema.Type)
    },
  }),
)

export const HostContextsChannelLive = Layer.succeed(
  HostContextsChannel,
  makeIngressChannel({
    target: HostContextsChannelTarget,
    schema: RuntimeContextSchema,
    stream: Stream.empty,
  }),
)

export const HostContextSnapshotChannelLive = Layer.succeed(
  HostContextSnapshotChannel,
  makeCallableChannel({
    target: HostContextSnapshotChannelTarget,
    requestSchema: HostContextSnapshotRequestSchema,
    responseSchema: RuntimeContextSnapshotSchema,
    call: (request) =>
      Effect.succeed({
        contextId: request.contextId,
        runs: [] as ReadonlyArray<unknown>,
        events: [] as ReadonlyArray<unknown>,
        logs: [] as ReadonlyArray<unknown>,
        agentOutputs: [],
      } as unknown as typeof RuntimeContextSnapshotSchema.Type),
  }),
)

export const HostSessionSnapshotChannelLive = Layer.succeed(
  HostSessionSnapshotChannel,
  makeCallableChannel({
    target: HostSessionSnapshotChannelTarget,
    requestSchema: HostSessionSnapshotRequestSchema,
    responseSchema: RuntimeContextSnapshotSchema,
    call: (request) =>
      Effect.succeed({
        contextId: request.sessionId,
        runs: [] as ReadonlyArray<unknown>,
        events: [] as ReadonlyArray<unknown>,
        logs: [] as ReadonlyArray<unknown>,
        agentOutputs: [],
      } as unknown as typeof RuntimeContextSnapshotSchema.Type),
  }),
)

export const SessionLifecycleChannelLive = Layer.succeed(
  SessionLifecycleChannel,
  SessionLifecycleChannel.of({
    forSession: (_sessionId) =>
      makeIngressChannel({
        target: SessionLifecycleChannelTarget,
        schema: RuntimeRunEventSchema,
        stream: Stream.empty,
      }),
  }),
)

export const UnifiedChannelBindingsLive = Layer.mergeAll(
  HostPromptChannelLive,
  SessionPromptChannelLive,
  HostSessionsStartChannelLive,
  HostPermissionRespondChannelLive,
  HostContextsCreateChannelLive,
  HostSessionsCreateOrLoadChannelLive,
  HostContextsChannelLive,
  HostContextSnapshotChannelLive,
  HostSessionSnapshotChannelLive,
  SessionLifecycleChannelLive,
)
