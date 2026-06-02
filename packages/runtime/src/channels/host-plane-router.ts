import {
  acknowledgementCompletion,
  HostPermissionRespondChannel,
  HostPermissionRespondChannelRequestSchema,
  HostSessionsCreateOrLoadChannel,
  HostSessionsStartChannel,
  HostSessionsStartRequestSchema,
  SessionCancelChannel,
  SessionCancelChannelTarget,
  SessionCloseChannel,
  SessionCloseChannelTarget,
  SessionPromptChannel,
  SessionPromptChannelTarget,
  type ChannelTarget,
  type DurableEventChannel,
} from "@firegrid/protocol/channels"
import {
  SessionHandlePromptInputSchema,
} from "@firegrid/protocol/session-facade"
import { Effect, Layer, Schema } from "effect"
import {
  HostPlaneChannelRouter,
  makeRuntimeChannelRouter,
  runtimeRouteFromChannel,
  runtimeRouteFromFactoryChannel,
  type RuntimeChannelRoute,
} from "./router.ts"

export const SessionPromptRouteInputSchema = Schema.Struct({
  sessionId: Schema.String.pipe(Schema.minLength(1)),
  prompt: SessionHandlePromptInputSchema,
})
export type SessionPromptRouteInput = Schema.Schema.Type<
  typeof SessionPromptRouteInputSchema
>

const eventAcknowledgementRoute = <S extends Schema.Schema.Any>(
  target: ChannelTarget,
  schema: S,
  channel: DurableEventChannel<S>,
): RuntimeChannelRoute<unknown, unknown> => ({
  descriptor: {
    target,
    direction: "egress",
    verbs: ["send", "call"],
    inputSchema: schema,
    metadata: {
      target,
      direction: "egress",
      verbs: ["send", "call"],
      schema: {
        direction: "egress",
        schema,
      },
      completion: acknowledgementCompletion,
    },
  },
  invoke: payload => channel.binding.append(payload as Schema.Schema.Type<S>),
})

export const HostPlaneSessionControlRouterLive = Layer.effect(
  HostPlaneChannelRouter,
  Effect.gen(function*() {
    const createOrLoad = yield* HostSessionsCreateOrLoadChannel
    const sessionPrompt = yield* SessionPromptChannel
    const start = yield* HostSessionsStartChannel
    const cancel = yield* SessionCancelChannel
    const close = yield* SessionCloseChannel
    const permissionRespond = yield* HostPermissionRespondChannel
    return makeRuntimeChannelRouter([
      runtimeRouteFromChannel(createOrLoad),
      runtimeRouteFromFactoryChannel({
        target: SessionPromptChannelTarget,
        field: "sessionId",
        inputSchema: SessionPromptRouteInputSchema,
        channel: sessionId => sessionPrompt.forSession(String(sessionId)),
        payload: input => input.prompt,
      }),
      eventAcknowledgementRoute(
        start.target,
        HostSessionsStartRequestSchema,
        start,
      ),
      eventAcknowledgementRoute(
        SessionCancelChannelTarget,
        cancel.schema,
        cancel,
      ),
      eventAcknowledgementRoute(
        SessionCloseChannelTarget,
        close.schema,
        close,
      ),
      eventAcknowledgementRoute(
        permissionRespond.target,
        HostPermissionRespondChannelRequestSchema,
        permissionRespond,
      ),
    ])
  }),
)
