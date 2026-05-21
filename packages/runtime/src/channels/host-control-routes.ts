import {
  HostContextsChannel,
  HostContextsCreateChannel,
  HostPermissionRespondChannel,
  HostPromptChannel,
  HostSessionsCreateOrLoadChannel,
  HostSessionsStartChannel,
  SessionLifecycleChannel,
  SessionLifecycleChannelTarget,
  SessionPromptChannel,
  SessionPromptChannelTarget,
  makeIngressChannel,
} from "@firegrid/protocol/channels"
import {
  RuntimeControlPlaneTable,
  RuntimeRunEventSchema,
  makeHostContextsChannel,
  makeHostContextsCreateChannel,
  makeHostPermissionRespondChannel,
  makeHostPromptChannel,
  makeHostSessionsCreateOrLoadRequestRowChannel,
  makeHostSessionsStartChannel,
  makeSessionPromptChannelForSession,
  type RuntimeControlPlaneTableService,
} from "@firegrid/protocol/launch"
import {
  SessionHandlePromptInputSchema,
} from "@firegrid/protocol/session-facade"
import { Effect, Layer, Schema, Stream } from "effect"
import {
  HostPlaneChannelRouter,
  makeRuntimeChannelRouter,
  runtimeRouteFromChannel,
  runtimeRouteFromFactoryChannel,
} from "./router.ts"

export const SessionPromptRouteInputSchema = Schema.Struct({
  sessionId: Schema.String.pipe(Schema.minLength(1)),
  prompt: SessionHandlePromptInputSchema,
}).annotations({
  identifier: "firegrid.channel.sessionPrompt.routeInput",
  title: "Session prompt route input",
})
export type SessionPromptRouteInput = Schema.Schema.Type<
  typeof SessionPromptRouteInputSchema
>

export const makeRuntimeHostSessionsCreateOrLoadChannel = (
  control: RuntimeControlPlaneTableService,
  options?: {
    readonly bindingSource?: string
  },
) => makeHostSessionsCreateOrLoadRequestRowChannel(control, options)

export const RuntimeHostControlChannelsLive = Layer.unwrapEffect(
  Effect.gen(function*() {
    const control = yield* RuntimeControlPlaneTable
    const contextsCreate = makeHostContextsCreateChannel(control)
    const hostPrompt = makeHostPromptChannel(control)
    const sessionPrompt = {
      forSession: (sessionId: string) =>
        makeSessionPromptChannelForSession(control, sessionId),
    }
    const sessionsStart = makeHostSessionsStartChannel(control)
    const permissionRespond = makeHostPermissionRespondChannel(control)
    const contexts = makeHostContextsChannel(control)
    const sessionsCreateOrLoad = makeRuntimeHostSessionsCreateOrLoadChannel(control)
    const router = makeRuntimeChannelRouter([
      runtimeRouteFromChannel(contextsCreate),
      runtimeRouteFromChannel(hostPrompt),
      runtimeRouteFromFactoryChannel({
        target: SessionPromptChannelTarget,
        field: "sessionId",
        inputSchema: SessionPromptRouteInputSchema,
        channel: sessionPrompt.forSession,
        payload: input => input.prompt,
      }),
      runtimeRouteFromChannel(sessionsStart),
      runtimeRouteFromChannel(permissionRespond),
      runtimeRouteFromChannel(contexts),
      runtimeRouteFromChannel(sessionsCreateOrLoad),
    ])

    return Layer.mergeAll(
      // SessionLifecycleChannel is intentionally observation-only here. The
      // router declares every dispatched host-control channel; lifecycle remains
      // a stream service consumed through its typed channel tag.
      Layer.succeed(HostContextsCreateChannel, contextsCreate),
      Layer.succeed(HostPromptChannel, hostPrompt),
      Layer.succeed(SessionPromptChannel, sessionPrompt),
      Layer.succeed(HostSessionsStartChannel, sessionsStart),
      Layer.succeed(HostPermissionRespondChannel, permissionRespond),
      Layer.succeed(HostContextsChannel, contexts),
      Layer.succeed(HostSessionsCreateOrLoadChannel, sessionsCreateOrLoad),
      Layer.succeed(HostPlaneChannelRouter, router),
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
    )
  }),
)
