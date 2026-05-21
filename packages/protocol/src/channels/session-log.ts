import { Context, Schema } from "effect"
import { DurableTable } from "effect-durable-operators"
import {
  makeChannelTarget,
  type ChannelTarget,
  type EgressChannel,
} from "./core.ts"

export const SessionLogChannelTarget: ChannelTarget = makeChannelTarget("session.log")

export const SessionLogRowSchema = Schema.Struct({
  logId: Schema.String.pipe(DurableTable.primaryKey),
  contextId: Schema.String.pipe(Schema.minLength(1)),
  message: Schema.String,
  createdAt: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
}).annotations({
  identifier: "firegrid.channel.sessionLog.row",
  title: "Session log row",
})
export type SessionLogRow = Schema.Schema.Type<typeof SessionLogRowSchema>

export type SessionLogChannel = EgressChannel<typeof SessionLogRowSchema> & {
  readonly kind: "session.log"
  readonly storage: "durable-table"
}

export class SessionLogChannelTag extends Context.Tag(
  "firegrid/protocol/channels/session.log",
)<SessionLogChannelTag, SessionLogChannel>() {}
