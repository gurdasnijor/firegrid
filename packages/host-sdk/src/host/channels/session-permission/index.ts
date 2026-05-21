import {
  RuntimeControlPlaneTable,
  type RuntimeInputIntentRow,
} from "@firegrid/protocol/launch"
import {
  makeSessionPermissionChannelContract,
  SessionPermissionChannel,
  type SessionPermissionChannelRequest,
  type SessionPermissionChannelResponse,
  type SessionPermissionChannelService,
} from "@firegrid/protocol/channels/session-permission"
import {
  makeRuntimeInputIntentRow,
} from "@firegrid/protocol/runtime-ingress"
import { stampRowOtel } from "@firegrid/protocol/otel"
import { Effect, Layer, Schema } from "effect"

export class SessionPermissionDecisionMissing extends Schema.TaggedError<SessionPermissionDecisionMissing>()(
  "SessionPermissionDecisionMissing",
  {
    sessionId: Schema.String,
    permissionRequestId: Schema.String,
  },
) {}

const permissionResponseMetadata = (
  request: SessionPermissionChannelRequest,
): Readonly<Record<string, string>> | undefined =>
  request.responseOrigin === undefined
    ? undefined
    : { "firegrid.permission.response.origin": request.responseOrigin }

const makePermissionIntent = (
  sessionId: string,
  request: SessionPermissionChannelRequest & {
    readonly decision: NonNullable<SessionPermissionChannelRequest["decision"]>
  },
): RuntimeInputIntentRow =>
  makeRuntimeInputIntentRow({
    contextId: sessionId,
    kind: "required_action_result",
    authoredBy: "client",
    payload: {
      _tag: "PermissionResponse",
      permissionRequestId: request.permissionRequestId,
      decision: request.decision,
    },
    idempotencyKey: request.idempotencyKey ??
      `permission-response:${sessionId}:${request.permissionRequestId}`,
    metadata: permissionResponseMetadata(request),
  })

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
            const intent = makePermissionIntent(options.sessionId, {
              ...request,
              decision: request.decision,
            })
            const stamped = yield* stampRowOtel(intent)
            const stored = yield* control.inputIntents.insertOrGet(stamped)
            const row = stored._tag === "Found" ? stored.row : stamped
            return {
              responded: true,
              contextId: options.sessionId,
              permissionRequestId: request.permissionRequestId,
              inputId: row.intentId,
            }
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
