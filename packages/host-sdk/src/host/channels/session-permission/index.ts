import {
  RuntimeControlPlaneTable,
} from "@firegrid/protocol/launch"
import {
  makeSessionPermissionChannelContract,
  SessionPermissionChannel,
  type SessionPermissionChannelRequest,
  type SessionPermissionChannelResponse,
  type SessionPermissionChannelService,
} from "@firegrid/protocol/channels/session-permission"
import { submitSessionPermissionResponse } from "@firegrid/runtime/channels"
import { Effect, Layer, Schema } from "effect"

export class SessionPermissionDecisionMissing extends Schema.TaggedError<SessionPermissionDecisionMissing>()(
  "SessionPermissionDecisionMissing",
  {
    sessionId: Schema.String,
    permissionRequestId: Schema.String,
  },
) {}

export const makeSessionPermissionChannel = (options: {
  readonly sessionId: string
  readonly respond: (
    request: SessionPermissionChannelRequest,
  ) => Effect.Effect<SessionPermissionChannelResponse, unknown, never>
}): SessionPermissionChannelService =>
  makeSessionPermissionChannelContract({
    call: request =>
      options.respond(request).pipe(
        Effect.withSpan("firegrid.channel.session_permission.call", {
          kind: "producer",
          attributes: {
            "firegrid.session.id": options.sessionId,
            "firegrid.permission.request_id": request.permissionRequestId,
            "firegrid.permission.response.origin": request.responseOrigin ?? "",
          },
        }),
      ),
  })

export const SessionPermissionChannelLive = (options: {
  readonly sessionId: string
}) =>
  Layer.effect(
    SessionPermissionChannel,
    Effect.gen(function*() {
      const control = yield* RuntimeControlPlaneTable
      return makeSessionPermissionChannel({
        sessionId: options.sessionId,
        respond: request =>
          Effect.gen(function*() {
            if (request.decision === undefined) {
              return yield* new SessionPermissionDecisionMissing({
                sessionId: options.sessionId,
                permissionRequestId: request.permissionRequestId,
              })
            }
            return yield* submitSessionPermissionResponse(control, options.sessionId, {
              ...request,
              decision: request.decision,
            })
          }),
      })
    }),
  )

export const SessionPermissionAutoApproveLayer = (options: {
  readonly sessionId: string
  readonly defaultBinding: SessionPermissionChannelService
  readonly decision: NonNullable<SessionPermissionChannelRequest["decision"]>
  readonly responseOrigin: string
}): Layer.Layer<SessionPermissionChannel> =>
  Layer.scoped(
    SessionPermissionChannel,
    Effect.succeed(
      makeSessionPermissionChannel({
        sessionId: options.sessionId,
        respond: request =>
          options.defaultBinding.binding.call({
            ...request,
            decision: options.decision,
            responseOrigin: options.responseOrigin,
          }),
      }),
    ),
  )
