import {
  HostContextSnapshotChannel,
  HostContextSnapshotChannelTarget,
  HostContextSnapshotRequestSchema,
  HostContextsChannel,
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
  RuntimeRunEventSchema,
  makeHostContextsChannel,
  makeHostContextsCreateChannel,
  makeHostPermissionRespondChannel,
  makeHostPromptChannel,
  makeHostSessionsStartChannel,
  makeSessionPromptChannelForSession,
} from "@firegrid/protocol/launch"
import {
  hostSessionLifecycleStream,
  makeHostControlSnapshot,
} from "@firegrid/runtime/channels"
import { Effect, Layer } from "effect"
import { RuntimeHostConfig } from "../../config.ts"

// tf-bffo (PARTIAL): the durable snapshot reads + the session-lifecycle run stream
// now live in @firegrid/runtime/channels; this layer composes them.
//
// REMAINING CARVEOUT (tf-9x11, blocks tf-bffo): the contexts.create / prompt /
// session.prompt / sessions.start / permissions.respond request-row channel lives are
// still constructed here from RuntimeControlPlaneTable via the @firegrid/protocol/launch
// factories (makeHostContextsCreateChannel(control), etc.). Those table-bound channel
// lives still sit ABOVE the runtime channels box and are NOT relocated by this PR.
// Canonical end-state: docs/sdds/SDD_FIREGRID_HOST_PLANE_CHANNEL_ROUTER.md (tf-rd3d) —
// protocol owns route contracts, runtime/kernel owns route IMPLEMENTATIONS, host-sdk
// composes the router (FiregridHostChannelRouterLive) + edges. These factory-built
// channel lives are route implementations that belong on the runtime side of the
// router; host-sdk must NOT own durable route bodies in the end state. The router
// end-to-end implementation (which replaces HostControlChannelsLive) is tracked by
// tf-9x11.

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

      const snapshotForContext = makeHostControlSnapshot(control, {
        durableStreamsBaseUrl: config.durableStreamsBaseUrl,
        ...(config.headers === undefined ? {} : { headers: config.headers }),
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
          makeHostContextsChannel(control),
        ),
        Layer.succeed(SessionLifecycleChannel, {
          forSession: sessionId =>
            makeIngressChannel({
              target: SessionLifecycleChannelTarget,
              schema: RuntimeRunEventSchema,
              sourceClass: "static-source",
              stream: hostSessionLifecycleStream(control, sessionId),
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
