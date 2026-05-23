import {
  HostContextsChannel,
  HostContextsCreateChannel,
  HostPermissionRespondChannel,
  HostPromptChannel,
  HostSessionsCreateOrLoadChannel,
  HostSessionsStartChannel,
  SessionAgentOutputChannel,
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
import { sessionAgentOutputObservationRoute } from "./session-agent-output-route.ts"
import { sessionLifecycleTerminalRoute } from "./session-lifecycle-route.ts"

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
    // Wave C (#702 mapping): `session.wait.forAgentOutput → session.agent_output / wait_for`
    // is the 7th and last public-turn mapping. It registers on the existing
    // `HostPlaneChannelRouter` (no new session-plane router; see SDD and
    // SessionPromptChannel precedent — both are session-scoped factory-keyed
    // channels surfaced through the host-plane edge dispatch surface). The
    // route definition (`sessionAgentOutputObservationRoute`) was landed but
    // unregistered; this slice adds the registration only. Host-sdk continues
    // to supply the `SessionAgentOutputChannel` Live binding
    // (`SessionAgentOutputChannelLive`) at composition time.
    const sessionAgentOutput = yield* SessionAgentOutputChannel
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
    // Wave C (#708 GREEN): `session.lifecycle / wait_for` joins the router
    // alongside `session.agent_output / wait_for`. Same factory-keyed
    // ingress pattern; the route filters to terminal `RuntimeRunEvent`
    // status (exited|failed) so a public-turn `wait_for` settles only when
    // the body's lifecycle row has materialized. This replaces the
    // settlement-via-`session.agent_output Terminated` shape (which races
    // body completion) with the durable runs.exited/failed row.
    const sessionLifecycle: SessionLifecycleChannel["Type"] = {
      forSession: (sessionId) =>
        makeIngressChannel({
          target: SessionLifecycleChannelTarget,
          schema: RuntimeRunEventSchema,
          sourceClass: "static-source",
          stream: control.runs.rows().pipe(
            Stream.filter((row) => row.contextId === sessionId),
          ),
        }),
    }
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
      sessionAgentOutputObservationRoute(sessionAgentOutput),
      sessionLifecycleTerminalRoute(sessionLifecycle),
    ])

    return Layer.mergeAll(
      Layer.succeed(HostContextsCreateChannel, contextsCreate),
      Layer.succeed(HostPromptChannel, hostPrompt),
      Layer.succeed(SessionPromptChannel, sessionPrompt),
      Layer.succeed(HostSessionsStartChannel, sessionsStart),
      Layer.succeed(HostPermissionRespondChannel, permissionRespond),
      Layer.succeed(HostContextsChannel, contexts),
      Layer.succeed(HostSessionsCreateOrLoadChannel, sessionsCreateOrLoad),
      Layer.succeed(HostPlaneChannelRouter, router),
      // SessionLifecycleChannel — now ALSO a router route (see above) AND
      // a direct service tag for in-process consumers.
      Layer.succeed(SessionLifecycleChannel, sessionLifecycle),
    )
  }),
)
