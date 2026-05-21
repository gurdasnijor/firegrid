import {
  HostContextSnapshotChannel,
  HostContextSnapshotChannelTarget,
  HostContextSnapshotRequestSchema,
  HostContextsChannel,
  HostContextsChannelTarget,
  HostContextsCreateChannel,
  HostPermissionRespondChannel,
  HostPromptChannel,
  HostSessionSnapshotChannel,
  HostSessionSnapshotChannelTarget,
  HostSessionSnapshotRequestSchema,
  HostSessionsStartChannel,
  RuntimeContextSnapshotSchema,
  SessionLifecycleChannel,
  SessionLifecycleChannelTarget,
  SessionPromptChannel,
  makeCallableChannel,
  makeIngressChannel,
} from "@firegrid/protocol/channels"
import {
  RuntimeControlPlaneTable,
  RuntimeContextSchema,
  RuntimeOutputTable,
  RuntimeRunEventSchema,
  makeHostContextsCreateChannel,
  makeHostPermissionRespondChannel,
  makeHostPromptChannel,
  makeHostSessionsStartChannel,
  makeSessionPromptChannelForSession,
  runtimeContextOutputStreamUrl,
  type RuntimeContextRow,
  type RuntimeRunEventRow,
} from "@firegrid/protocol/launch"
import {
  runtimeAgentOutputObservationFromRow,
} from "@firegrid/protocol/session-facade"
import { Effect, Layer, Option, Stream } from "effect"
import { RuntimeHostConfig } from "../../config.ts"

const runStatusRank = (status: RuntimeRunEventRow["status"]): number =>
  status === "started" ? 0 : status === "failed" ? 1 : 2

const latestRunStatus = (
  runs: ReadonlyArray<RuntimeRunEventRow>,
) =>
  [...runs].sort((left, right) =>
    left.at.localeCompare(right.at) ||
    runStatusRank(left.status) - runStatusRank(right.status)).at(-1)?.status

const outputLayerForContext = (
  config: RuntimeHostConfig["Type"],
  context: RuntimeContextRow,
) =>
  RuntimeOutputTable.layer({
    streamOptions: {
      url: runtimeContextOutputStreamUrl({
        baseUrl: config.durableStreamsBaseUrl,
        prefix: context.host.streamPrefix,
        contextId: context.contextId,
      }),
      contentType: "application/json",
      ...(config.headers === undefined ? {} : { headers: config.headers }),
    },
  })

// tf-aago: the contexts.create / prompt / session.prompt / sessions.start /
// permissions.respond bindings now come from the shared
// @firegrid/protocol/launch factories (the single source of truth the
// client-sdk standalone defaults also consume). The local
// appendInputIntent / permissionResponseInput / appendContextCreateRequest
// helpers were deleted; only the snapshot/contexts/lifecycle bindings (which
// need RuntimeHostConfig + RuntimeOutputTable) remain inline below.

type HostControlChannels =
  | HostContextsCreateChannel
  | HostPromptChannel
  | SessionPromptChannel
  | HostSessionsStartChannel
  | HostContextSnapshotChannel
  | HostSessionSnapshotChannel
  | HostContextsChannel
  | SessionLifecycleChannel
  | HostPermissionRespondChannel

export const HostControlChannelsLive =
  Layer.unwrapEffect(
    Effect.gen(function*() {
      const control = yield* RuntimeControlPlaneTable
      const config = yield* RuntimeHostConfig

      const snapshotForContext = (contextId: string) =>
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
          }).pipe(Effect.provide(outputLayerForContext(config, context.value)))
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

      return Layer.mergeAll(
        Layer.succeed(
          HostContextsCreateChannel,
          makeHostContextsCreateChannel(control),
        ),
        Layer.succeed(HostPromptChannel, makeHostPromptChannel(control)),
        Layer.succeed(SessionPromptChannel, {
          forSession: sessionId =>
            makeSessionPromptChannelForSession(control, sessionId),
        }),
        Layer.succeed(
          HostSessionsStartChannel,
          makeHostSessionsStartChannel(control),
        ),
        Layer.succeed(
          HostContextSnapshotChannel,
          makeCallableChannel({
            target: HostContextSnapshotChannelTarget,
            requestSchema: HostContextSnapshotRequestSchema,
            responseSchema: RuntimeContextSnapshotSchema,
            call: request => snapshotForContext(request.contextId),
          }),
        ),
        Layer.succeed(
          HostSessionSnapshotChannel,
          makeCallableChannel({
            target: HostSessionSnapshotChannelTarget,
            requestSchema: HostSessionSnapshotRequestSchema,
            responseSchema: RuntimeContextSnapshotSchema,
            call: request => snapshotForContext(request.sessionId),
          }),
        ),
        Layer.succeed(
          HostContextsChannel,
          makeIngressChannel({
            target: HostContextsChannelTarget,
            schema: RuntimeContextSchema,
            sourceClass: "static-source",
            stream: control.contexts.rows(),
          }),
        ),
        Layer.succeed(SessionLifecycleChannel, {
          forSession: sessionId =>
            makeIngressChannel({
              target: SessionLifecycleChannelTarget,
              schema: RuntimeRunEventSchema,
              sourceClass: "static-source",
              stream: control.runs.rows().pipe(
                Stream.filter(row => row.contextId === sessionId),
              ),
            }),
        }),
        Layer.succeed(
          HostPermissionRespondChannel,
          makeHostPermissionRespondChannel(control),
        ),
      )
    }),
  ) as Layer.Layer<
    HostControlChannels,
    never,
    RuntimeControlPlaneTable | RuntimeHostConfig
  >
