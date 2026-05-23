import {
  HostContextSnapshotChannel,
  HostContextSnapshotChannelTarget,
  HostContextSnapshotRequestSchema,
  HostSessionSnapshotChannel,
  HostSessionSnapshotChannelTarget,
  HostSessionSnapshotRequestSchema,
  RuntimeContextSnapshotSchema,
  makeCallableChannel,
  type HostContextsChannel,
  type HostContextsCreateChannel,
  type HostPermissionRespondChannel,
  type HostPromptChannel,
  type HostSessionsStartChannel,
  type SessionAgentOutputChannel,
  type SessionLifecycleChannel,
  type SessionPromptChannel,
} from "@firegrid/protocol/channels"
import {
  type CurrentHostSession,
  RuntimeControlPlaneTable,
} from "@firegrid/protocol/launch"
import {
  RuntimeHostControlChannelsLive,
  makeHostControlSnapshot,
  type HostPlaneChannelRouter,
} from "@firegrid/runtime/channels"
import { Effect, Layer } from "effect"
import { RuntimeHostConfig } from "../../config.ts"
import { SessionAgentOutputChannelLive } from "../session-agent-output/index.ts"

// Host-control write/read route bindings live in @firegrid/runtime/channels.
// Host-sdk keeps the snapshot bindings (need RuntimeHostConfig to open
// per-context output streams) and provides the SessionAgentOutputChannel
// Live binding (host-sdk owns the Layer because it needs RuntimeHostConfig +
// CurrentHostSession to bind the durable stream prefix per context).
//
// Wave C (#702 mapping): `session.wait.forAgentOutput → session.agent_output /
// wait_for` registered the corresponding route on
// `RuntimeHostControlChannelsLive` in
// `packages/runtime/src/channels/host-control-routes.ts`. That route declares
// `SessionAgentOutputChannel` as a service requirement on the runtime Layer;
// host-sdk fills it here via `SessionAgentOutputChannelLive`. The output of
// `HostControlChannelsLive` includes `SessionAgentOutputChannel` because the
// provided Layer exposes it; the requirement set honestly carries
// `CurrentHostSession` since `SessionAgentOutputChannelLive` needs it.

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
  | SessionAgentOutputChannel
  | HostPlaneChannelRouter

export const HostControlChannelsLive =
  Layer.unwrapEffect(
    Effect.gen(function*() {
      const control = yield* RuntimeControlPlaneTable
      const config = yield* RuntimeHostConfig

      const snapshotForContext = makeHostControlSnapshot(control, {
        durableStreamsBaseUrl: config.durableStreamsBaseUrl,
        ...(config.headers === undefined ? {} : { headers: config.headers }),
      })

      const snapshotChannels = Layer.mergeAll(
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
      )
      return RuntimeHostControlChannelsLive.pipe(
        Layer.provide(SessionAgentOutputChannelLive),
        Layer.provideMerge(snapshotChannels),
      )
    }),
  ) as Layer.Layer<
    HostControlChannels,
    never,
    RuntimeControlPlaneTable | RuntimeHostConfig | CurrentHostSession
  >
