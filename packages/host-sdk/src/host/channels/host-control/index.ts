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
  type SessionLifecycleChannel,
  type SessionPromptChannel,
} from "@firegrid/protocol/channels"
import {
  RuntimeControlPlaneTable,
} from "@firegrid/protocol/launch"
import {
  RuntimeHostControlChannelsLive,
  makeHostControlSnapshot,
  type HostPlaneChannelRouter,
} from "@firegrid/runtime/channels"
import { Effect, Layer } from "effect"
import { RuntimeHostConfig } from "../../config.ts"

// Host-control write/read route bindings live in @firegrid/runtime/channels.
// Host-sdk keeps only the snapshot bindings that need RuntimeHostConfig to
// open per-context output streams.

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
        Layer.provideMerge(snapshotChannels),
      )
    }),
  ) as Layer.Layer<
    HostControlChannels,
    never,
    RuntimeControlPlaneTable | RuntimeHostConfig
  >
