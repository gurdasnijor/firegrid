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

// tf-bffo: host-sdk COMPOSES only. The contexts.create / prompt / session.prompt /
// sessions.start / permissions.respond bindings come from the @firegrid/protocol/launch
// factories; the durable snapshot reads + the session-lifecycle run stream now live in
// @firegrid/runtime/channels. This layer resolves the control table + host config and
// wires them together — it owns no durable-state logic.

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
