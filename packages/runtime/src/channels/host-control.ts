import {
  HostContextsCreateChannel,
  HostContextsCreateChannelTarget,
  HostContextsCreateRequestSchema,
  HostContextsCreateResponseSchema,
  HostSessionsCreateOrLoadChannel,
  HostSessionsCreateOrLoadChannelTarget,
  HostSessionsCreateOrLoadRequestSchema,
  HostSessionsCreateOrLoadResponseSchema,
  SessionLifecycleChannel,
  SessionLifecycleChannelTarget,
  makeCallableChannel,
  makeIngressChannel,
} from "@firegrid/protocol/channels"
import {
  CurrentHostSession,
  type HostSessionRow,
  type RuntimeContext,
  RuntimeControlPlaneTable,
  RuntimeRunEventSchema,
  runtimeRunsForContextView,
} from "@firegrid/protocol/launch"
import { Clock, Effect, Layer } from "effect"

// tf-bffo: the durable host-control reads (context/run/output snapshot + the
// session-lifecycle run stream) are kernel-internal durable-state behavior and
// live in the runtime. host-sdk only COMPOSES these builders (plus the
// protocol-owned channel factories) into the HostControl channel layer.

export const hostSessionLifecycleStream = (
  control: RuntimeControlPlaneTable["Type"],
  sessionId: string,
) =>
  runtimeRunsForContextView(control.runs.rows(), sessionId)

const insertHostBoundRuntimeContext = (options: {
  readonly control: RuntimeControlPlaneTable["Type"]
  readonly hostSession: HostSessionRow
  readonly contextId: string
  readonly createdBy?: string
  readonly parentContextId?: string
  readonly runtime: Omit<RuntimeContext["runtime"], "journal">
}) =>
  Effect.gen(function*() {
    const nowMs = yield* Clock.currentTimeMillis
    yield* options.control.contexts.insertOrGet({
      contextId: options.contextId,
      createdAt: new Date(nowMs).toISOString(),
      ...(options.createdBy === undefined ? {} : { createdBy: options.createdBy }),
      ...(options.parentContextId === undefined ? {} : { parentContextId: options.parentContextId }),
      runtime: {
        provider: options.runtime.provider,
        config: options.runtime.config,
        journal: [],
      },
      host: {
        hostId: options.hostSession.hostId,
        streamPrefix: options.hostSession.streamPrefix,
        boundAtMs: nowMs,
      },
    }).pipe(Effect.orDie, Effect.asVoid)
  })

const runtimeContextProvenance = (options: {
  readonly createdBy: string | undefined
  readonly parentContextId: string | undefined
}) => ({
  ...(options.createdBy === undefined ? {} : { createdBy: options.createdBy }),
  ...(options.parentContextId === undefined ? {} : { parentContextId: options.parentContextId }),
})

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
          yield* insertHostBoundRuntimeContext({
            control,
            hostSession,
            contextId: request.contextId,
            ...runtimeContextProvenance({
              createdBy: request.createdBy,
              parentContextId: request.parentContextId,
            }),
            runtime: request.runtime,
          })
          return {
            sessionId: request.contextId,
            contextId: request.contextId,
          } as typeof HostContextsCreateResponseSchema.Type
        }),
    })
  }),
)

export const HostSessionsCreateOrLoadChannelLive = Layer.effect(
  HostSessionsCreateOrLoadChannel,
  Effect.gen(function*() {
    const control = yield* RuntimeControlPlaneTable
    const hostSession = yield* CurrentHostSession
    return makeCallableChannel({
      target: HostSessionsCreateOrLoadChannelTarget,
      requestSchema: HostSessionsCreateOrLoadRequestSchema,
      responseSchema: HostSessionsCreateOrLoadResponseSchema,
      call: (request) =>
        Effect.gen(function*() {
          const id = `session:${request.externalKey.source}:${request.externalKey.id}`
          yield* insertHostBoundRuntimeContext({
            control,
            hostSession,
            contextId: id,
            ...runtimeContextProvenance({
              createdBy: request.createdBy,
              parentContextId: request.parentContextId,
            }),
            runtime: request.runtime,
          })
          return {
            sessionId: id,
            contextId: id,
          } as typeof HostSessionsCreateOrLoadResponseSchema.Type
        }),
    })
  }),
)

export const SessionLifecycleChannelLive = Layer.effect(
  SessionLifecycleChannel,
  Effect.gen(function*() {
    const control = yield* RuntimeControlPlaneTable
    return SessionLifecycleChannel.of({
      forSession: (sessionId) =>
        makeIngressChannel({
          target: SessionLifecycleChannelTarget,
          schema: RuntimeRunEventSchema,
          stream: hostSessionLifecycleStream(control, sessionId),
        }),
    })
  }),
)

export const HostControlChannelBindingsLive =
  HostContextsCreateChannelLive.pipe(
    Layer.provideMerge(HostSessionsCreateOrLoadChannelLive),
    Layer.provideMerge(SessionLifecycleChannelLive),
  )
