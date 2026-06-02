import {
  PermissionDecisionSchema,
} from "../agent-tools/schema.ts"
import { Context, Schema } from "effect"
import {
  EventOffsetSchema,
  makeCallableChannel,
  makeChannelTarget,
  type CallableChannel,
} from "./core.ts"

export const SessionPermissionChannelTarget = makeChannelTarget(
  "session.permissions.respond",
)

export const SessionPermissionChannelRequestSchema = Schema.Struct({
  permissionRequestId: Schema.String.pipe(Schema.minLength(1)),
  decision: Schema.optional(PermissionDecisionSchema),
  idempotencyKey: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  responseOrigin: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
}).annotations({
  identifier: "firegrid.channel.sessionPermission.request",
  title: "Session permission channel request",
})
export type SessionPermissionChannelRequest = Schema.Schema.Type<
  typeof SessionPermissionChannelRequestSchema
>

export const SessionPermissionChannelResponseSchema = EventOffsetSchema
export type SessionPermissionChannelResponse = Schema.Schema.Type<
  typeof SessionPermissionChannelResponseSchema
>

export type SessionPermissionChannelService = CallableChannel<
  typeof SessionPermissionChannelRequestSchema,
  typeof SessionPermissionChannelResponseSchema
>

export class SessionPermissionChannel extends Context.Tag(
  "firegrid/protocol/channels/session.permissions.respond",
)<SessionPermissionChannel, SessionPermissionChannelService>() {}

export const makeSessionPermissionChannelContract = (options: {
  readonly call: SessionPermissionChannelService["binding"]["call"]
}): SessionPermissionChannelService =>
  makeCallableChannel({
    target: SessionPermissionChannelTarget,
    requestSchema: SessionPermissionChannelRequestSchema,
    responseSchema: SessionPermissionChannelResponseSchema,
    call: options.call,
  })
