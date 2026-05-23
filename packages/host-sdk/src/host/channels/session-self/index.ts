import {
  RuntimeControlPlaneTable,
  type RuntimeRunEventRow,
} from "@firegrid/protocol/launch"
import {
  makeIngressChannel,
  SessionSelfLifecycleChannel,
  SessionSelfLifecycleChannelTarget,
  SessionSelfLifecycleEventSchema,
  type ChannelRegistration,
  type IngressChannel,
  type SessionSelfLifecycleEvent,
} from "@firegrid/protocol/channels"
import { Context, Effect, Layer, Stream } from "effect"
import {
  RuntimeChannelRouter,
  makeRuntimeContextChannelRouter,
} from "../../channel.ts"

// Wave D-E shrank this binding to the lifecycle ingress only. The previous
// workflow-engine row-projection ingress was retired — its kernel-side
// reader had no production populator post-D-A/D-B (zero successful router
// dispatches across six recent ACP elicitation traces) and its event schema
// leaked `@effect/workflow` engine-internal row shapes that cannon C6
// forbids as an agent observation surface. Only the lifecycle channel
// (the `RuntimeControlPlaneTable.runs.rows()` projection) remains.

const lifecycleEventFromRow = (
  row: RuntimeRunEventRow,
): SessionSelfLifecycleEvent => ({
  channel: "session.self.lifecycle",
  event: {
    runEventId: row.runEventId,
    contextId: row.contextId,
    activityAttempt: row.activityAttempt,
    status: row.status,
    at: row.at,
    provider: row.provider,
    ...(row.exitCode === undefined ? {} : { exitCode: row.exitCode }),
    ...(row.signal === undefined ? {} : { signal: row.signal }),
    ...(row.message === undefined ? {} : { message: row.message }),
  },
})

export const makeSessionSelfChannels = (
  options: {
    readonly control: RuntimeControlPlaneTable["Type"]
  },
): readonly [
  IngressChannel<typeof SessionSelfLifecycleEventSchema>,
] => [
  // firegrid-agent-body-plan.SESSION_SELF.1
  makeIngressChannel({
    target: SessionSelfLifecycleChannelTarget,
    schema: SessionSelfLifecycleEventSchema,
    stream: options.control.runs.rows().pipe(
      Stream.map(lifecycleEventFromRow),
      Stream.withSpan("firegrid.host.channel.session_self.lifecycle", {
        kind: "internal",
      }),
    ),
  }),
]

const makeSessionSelfChannelsEffect: Effect.Effect<
  readonly [
    IngressChannel<typeof SessionSelfLifecycleEventSchema>,
  ],
  never,
  RuntimeControlPlaneTable
> =
  Effect.context<RuntimeControlPlaneTable>().pipe(
    Effect.map((context) => {
      const control = Context.get(context, RuntimeControlPlaneTable)
      return makeSessionSelfChannels({ control })
    }),
  )

export const SessionSelfChannelsLive = (
  mcpChannels: ReadonlyArray<ChannelRegistration> = [],
): Layer.Layer<
  | SessionSelfLifecycleChannel
  | RuntimeChannelRouter,
  never,
  RuntimeControlPlaneTable
> => Layer.unwrapEffect(
  Effect.map(makeSessionSelfChannelsEffect, ([lifecycle]) =>
    Layer.mergeAll(
      Layer.succeed(SessionSelfLifecycleChannel, lifecycle),
      Layer.succeed(
        RuntimeChannelRouter,
        makeRuntimeContextChannelRouter([
          ...mcpChannels,
          lifecycle,
        ]),
      ),
    )),
)
