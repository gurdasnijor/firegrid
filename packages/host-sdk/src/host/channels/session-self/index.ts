import {
  SessionSelfCheckpointChannel,
  SessionSelfLifecycleChannel,
} from "@firegrid/protocol/channels"
import type {
  ChannelRegistration,
  IngressChannel,
  SessionSelfCheckpointEventSchema,
  SessionSelfLifecycleEventSchema,
} from "@firegrid/protocol/channels"
import { RuntimeControlPlaneTable } from "@firegrid/protocol/launch"
import { makeSessionSelfChannels } from "@firegrid/runtime/channels"
import { Context, Effect, Layer } from "effect"
import {
  RuntimeContextMcpChannelCatalog,
  makeRuntimeContextMcpChannelCatalog,
} from "../../channel.ts"
import { RuntimeContextCheckpointSource } from "../../runtime-context-workflow-runtime.ts"

// tf-bffo / tf-77ab: host-sdk COMPOSES only. The durable session-self channel
// implementations (lifecycle run stream + workflow-engine checkpoint snapshot/stream)
// live in @firegrid/runtime/channels. This layer resolves the control table + the
// checkpoint source and delegates to the runtime builder — it owns no durable logic.

const makeSessionSelfChannelsEffect: Effect.Effect<
  readonly [
    IngressChannel<typeof SessionSelfLifecycleEventSchema>,
    IngressChannel<typeof SessionSelfCheckpointEventSchema>,
  ],
  never,
  RuntimeControlPlaneTable | RuntimeContextCheckpointSource
> =
  Effect.context<RuntimeControlPlaneTable | RuntimeContextCheckpointSource>().pipe(
    Effect.map((context) => {
      const control = Context.get(context, RuntimeControlPlaneTable)
      const checkpoints = Context.get(context, RuntimeContextCheckpointSource)
      return makeSessionSelfChannels({ control, checkpoints })
    }),
  )

export const SessionSelfChannelsLive = (
  mcpChannels: ReadonlyArray<ChannelRegistration> = [],
): Layer.Layer<
  | SessionSelfLifecycleChannel
  | SessionSelfCheckpointChannel
  | RuntimeContextMcpChannelCatalog,
  never,
  RuntimeControlPlaneTable | RuntimeContextCheckpointSource
> => Layer.unwrapEffect(
  Effect.map(makeSessionSelfChannelsEffect, ([lifecycle, checkpoint]) =>
    Layer.mergeAll(
      Layer.succeed(SessionSelfLifecycleChannel, lifecycle),
      Layer.succeed(SessionSelfCheckpointChannel, checkpoint),
      Layer.succeed(
        RuntimeContextMcpChannelCatalog,
        makeRuntimeContextMcpChannelCatalog([
          ...mcpChannels,
          lifecycle,
          checkpoint,
        ]),
      ),
    )),
)
