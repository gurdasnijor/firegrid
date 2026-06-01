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
  HostSessionsCreateOrLoadChannel,
  HostSessionsCreateOrLoadChannelTarget,
  HostSessionsCreateOrLoadRequestSchema,
  HostSessionsCreateOrLoadResponseSchema,
  HostSessionSnapshotChannel,
  HostSessionSnapshotChannelTarget,
  HostSessionSnapshotRequestSchema,
  RuntimeContextSnapshotSchema,
  SessionLifecycleChannel,
  SessionLifecycleChannelTarget,
  makeCallableChannel,
  makeIngressChannel,
} from "@firegrid/protocol/channels"
import {
  CurrentHostSession,
  RuntimeContextSchema,
  RuntimeOutputTable,
  RuntimeControlPlaneTable,
  type RuntimeRunEventRow,
  RuntimeRunEventSchema,
} from "@firegrid/protocol/launch"
import { runtimeAgentOutputObservationFromRow } from "@firegrid/protocol/session-facade"
import type { DurableTableHeaders } from "effect-durable-operators"
import { Clock, Effect, Layer, Option, Stream } from "effect"
import { runtimeContextOutputTableLayerForContext } from "../tables/output-table-layer.ts"

// tf-bffo: the durable host-control reads (context/run/output snapshot + the
// session-lifecycle run stream) are kernel-internal durable-state behavior and
// live in the runtime. host-sdk only COMPOSES these builders (plus the
// protocol-owned channel factories) into the HostControl channel layer.

export interface HostControlSnapshotConfig {
  readonly durableStreamsBaseUrl: string
  readonly headers?: DurableTableHeaders
}

const runStatusRank = (status: RuntimeRunEventRow["status"]): number =>
  status === "started" ? 0 : status === "failed" ? 1 : 2

const latestRunStatus = (
  runs: ReadonlyArray<RuntimeRunEventRow>,
) =>
  [...runs].sort((left, right) =>
    left.at.localeCompare(right.at) ||
    runStatusRank(left.status) - runStatusRank(right.status)).at(-1)?.status

export const makeHostControlSnapshot = (
  control: RuntimeControlPlaneTable["Type"],
  config: HostControlSnapshotConfig,
) =>
(contextId: string) =>
  Effect.gen(function*() {
    const context = yield* control.contexts.get(contextId)
    const runs = yield* control.runs.query(coll =>
      coll.toArray.filter(row => row.contextId === contextId))
    if (Option.isNone(context)) {
      return {
        contextId,
        runs,
        events: [],
        logs: [],
        agentOutputs: [],
        ...(latestRunStatus(runs) === undefined
          ? {}
          : { status: latestRunStatus(runs) }),
      }
    }
    const [events, logs] = yield* Effect.gen(function*() {
      const output = yield* RuntimeOutputTable
      return yield* Effect.all([
        output.events.query(coll =>
          coll.toArray.filter(row => row.contextId === contextId)),
        output.logs.query(coll =>
          coll.toArray.filter(row => row.contextId === contextId)),
      ])
    }).pipe(Effect.provide(runtimeContextOutputTableLayerForContext(config, context.value)))
    return {
      contextId,
      context: context.value,
      ...(latestRunStatus(runs) === undefined
        ? {}
        : { status: latestRunStatus(runs) }),
      runs,
      events,
      logs,
      agentOutputs: events.flatMap(row => {
        const output = runtimeAgentOutputObservationFromRow(row)
        return Option.isSome(output) ? [output.value] : []
      }),
    }
  })

export const hostSessionLifecycleStream = (
  control: RuntimeControlPlaneTable["Type"],
  sessionId: string,
) =>
  control.runs.rows().pipe(
    Stream.filter(row => row.contextId === sessionId),
  )

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
          } as typeof HostContextsCreateResponseSchema.Type
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
      } as typeof HostSessionsCreateOrLoadResponseSchema.Type)
    },
  }),
)

export const HostContextsChannelLive = Layer.effect(
  HostContextsChannel,
  Effect.gen(function*() {
    const control = yield* RuntimeControlPlaneTable
    return makeIngressChannel({
      target: HostContextsChannelTarget,
      schema: RuntimeContextSchema,
      stream: control.contexts.rows(),
    })
  }),
)

export const HostContextSnapshotChannelLive = (
  config: HostControlSnapshotConfig,
) =>
  Layer.effect(
    HostContextSnapshotChannel,
    Effect.gen(function*() {
      const control = yield* RuntimeControlPlaneTable
      const snapshot = makeHostControlSnapshot(control, config)
      return makeCallableChannel({
        target: HostContextSnapshotChannelTarget,
        requestSchema: HostContextSnapshotRequestSchema,
        responseSchema: RuntimeContextSnapshotSchema,
        call: (request) => snapshot(request.contextId),
      })
    }),
  )

export const HostSessionSnapshotChannelLive = (
  config: HostControlSnapshotConfig,
) =>
  Layer.effect(
    HostSessionSnapshotChannel,
    Effect.gen(function*() {
      const control = yield* RuntimeControlPlaneTable
      const snapshot = makeHostControlSnapshot(control, config)
      return makeCallableChannel({
        target: HostSessionSnapshotChannelTarget,
        requestSchema: HostSessionSnapshotRequestSchema,
        responseSchema: RuntimeContextSnapshotSchema,
        call: (request) => snapshot(request.sessionId),
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

export const HostControlChannelBindingsLive = (
  config: HostControlSnapshotConfig,
) =>
  HostContextsCreateChannelLive.pipe(
    Layer.provideMerge(HostSessionsCreateOrLoadChannelLive),
    Layer.provideMerge(HostContextsChannelLive),
    Layer.provideMerge(HostContextSnapshotChannelLive(config)),
    Layer.provideMerge(HostSessionSnapshotChannelLive(config)),
    Layer.provideMerge(SessionLifecycleChannelLive),
  )
