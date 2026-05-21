import {
  HostContextsCreateChannelTarget,
  HostContextsCreateRequestSchema,
  HostContextsCreateResponseSchema,
  HostContextsChannel,
  HostContextsCreateChannel,
  HostPermissionRespondChannel,
  HostPromptChannel,
  HostSessionsCreateOrLoadChannel,
  HostSessionsCreateOrLoadChannelTarget,
  HostSessionsCreateOrLoadRequestSchema,
  HostSessionsCreateOrLoadResponseSchema,
  HostSessionsStartChannel,
  HostSessionsStartChannelTarget,
  HostSessionsStartRequestSchema,
  HostSessionsStartResponseSchema,
  SessionLifecycleChannel,
  SessionLifecycleChannelTarget,
  SessionPromptChannel,
  SessionPromptChannelTarget,
  makeCallableChannel,
  makeIngressChannel,
} from "@firegrid/protocol/channels"
import {
  CurrentHostSession,
  RuntimeControlPlaneTable,
  RuntimeRunEventSchema,
  makeHostContextsChannel,
  makeHostContextsCreateChannel,
  makeHostPermissionRespondChannel,
  makeHostPromptChannel,
  makeHostSessionsCreateOrLoadRequestRowChannel,
  makeHostSessionsStartChannel,
  makeSessionPromptChannelForSession,
  normalizeRuntimeIntent,
  runtimeContextRequestId,
  runtimeStartRequestId,
} from "@firegrid/protocol/launch"
import {
  FiregridSessionIdSchema,
  RuntimeContextIdSchema,
  SessionHandlePromptInputSchema,
  sessionContextIdForExternalKey,
} from "@firegrid/protocol/session-facade"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import {
  HostKernelControlPlane,
  type HostKernelControlPlaneService,
} from "../authorities/index.ts"
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

const sessionHandleForContextId = (contextId: string) =>
  Effect.gen(function*() {
    const sessionId = yield* Schema.decodeUnknown(FiregridSessionIdSchema)(
      contextId,
    )
    const runtimeContextId = yield* Schema.decodeUnknown(RuntimeContextIdSchema)(
      contextId,
    )
    return {
      sessionId,
      contextId: runtimeContextId,
    }
  })

export const makeRuntimeHostContextsCreateChannel = (
  hostId: string,
  control: HostKernelControlPlaneService,
) =>
  makeCallableChannel({
    target: HostContextsCreateChannelTarget,
    requestSchema: HostContextsCreateRequestSchema,
    responseSchema: HostContextsCreateResponseSchema,
    call: request =>
      control.signal(hostId, {
        _tag: "CreateLoad",
        requestId: runtimeContextRequestId(request.contextId),
        contextId: request.contextId,
        runtime: normalizeRuntimeIntent(request.runtime),
        ...(request.createdBy === undefined ? {} : { createdBy: request.createdBy }),
      }).pipe(
        Effect.flatMap(() => sessionHandleForContextId(request.contextId)),
        Effect.withSpan("firegrid.channel.host.contexts.create.call", {
          kind: "producer",
          attributes: {
            "firegrid.channel.target": HostContextsCreateChannelTarget,
            "firegrid.channel.direction": "call",
            "firegrid.context.id": request.contextId,
          },
        }),
      ),
  })

export const makeRuntimeHostSessionsCreateOrLoadChannel = (
  hostId: string,
  control: HostKernelControlPlaneService,
) =>
  makeCallableChannel({
    target: HostSessionsCreateOrLoadChannelTarget,
    requestSchema: HostSessionsCreateOrLoadRequestSchema,
    responseSchema: HostSessionsCreateOrLoadResponseSchema,
    call: request => {
      const contextId = sessionContextIdForExternalKey(request.externalKey)
      return control.signal(hostId, {
        _tag: "CreateLoad",
        requestId: runtimeContextRequestId(contextId),
        contextId,
        runtime: normalizeRuntimeIntent(request.runtime),
        ...(request.createdBy === undefined ? {} : { createdBy: request.createdBy }),
      }).pipe(
        Effect.flatMap(() => sessionHandleForContextId(contextId)),
        Effect.withSpan("firegrid.channel.host.sessions.create_or_load.call", {
          kind: "producer",
          attributes: {
            "firegrid.channel.target": HostSessionsCreateOrLoadChannelTarget,
            "firegrid.channel.direction": "call",
            "firegrid.context.id": contextId,
            "firegrid.external_key.source": request.externalKey.source,
            "firegrid.external_key.id": request.externalKey.id,
          },
        }),
      )
    },
  })

export const makeRuntimeHostSessionsStartChannel = (
  hostId: string,
  control: HostKernelControlPlaneService,
) =>
  makeCallableChannel({
    target: HostSessionsStartChannelTarget,
    requestSchema: HostSessionsStartRequestSchema,
    responseSchema: HostSessionsStartResponseSchema,
    call: request => {
      const requestId = runtimeStartRequestId(request.sessionId)
      return control.signal(hostId, {
        _tag: "Start",
        requestId,
        contextId: request.sessionId,
      }).pipe(
        Effect.map(ack => ({
          requestId,
          contextId: request.sessionId,
          inserted: ack.accepted,
        })),
        Effect.withSpan("firegrid.channel.host.sessions.start.call", {
          kind: "producer",
          attributes: {
            "firegrid.channel.target": HostSessionsStartChannelTarget,
            "firegrid.channel.direction": "call",
            "firegrid.context.id": request.sessionId,
          },
        }),
      )
    },
  })

export const RuntimeHostControlChannelsLive = Layer.unwrapEffect(
  Effect.gen(function*() {
    const control = yield* RuntimeControlPlaneTable
    const kernel = yield* Effect.serviceOption(HostKernelControlPlane)
    const hostSession = yield* CurrentHostSession
    const contextsCreate = Option.match(kernel, {
      onNone: () => makeHostContextsCreateChannel(control),
      onSome: kernel =>
        makeRuntimeHostContextsCreateChannel(
          hostSession.hostId,
          kernel,
        ),
    })
    const hostPrompt = makeHostPromptChannel(control)
    const sessionPrompt = {
      forSession: (sessionId: string) =>
        makeSessionPromptChannelForSession(control, sessionId),
    }
    const sessionsStart = Option.match(kernel, {
      onNone: () => makeHostSessionsStartChannel(control),
      onSome: kernel =>
        makeRuntimeHostSessionsStartChannel(
          hostSession.hostId,
          kernel,
        ),
    })
    const permissionRespond = makeHostPermissionRespondChannel(control)
    const contexts = makeHostContextsChannel(control)
    const sessionsCreateOrLoad = Option.match(kernel, {
      onNone: () => makeHostSessionsCreateOrLoadRequestRowChannel(control),
      onSome: kernel =>
        makeRuntimeHostSessionsCreateOrLoadChannel(
          hostSession.hostId,
          kernel,
        ),
    })
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
