import type {
  DurableTableCollectionFacade,
} from "effect-durable-operators"
import { DurableTable } from "effect-durable-operators"
import { Context, Schema } from "effect"
import type { Effect } from "effect"
import {
  makeChannelTarget,
  makeEgressChannel,
  type ChannelTarget,
  type EgressChannel,
} from "./channel.ts"

export const SessionLogChannelTarget = makeChannelTarget("session.log")

export const SessionLogRowSchema = Schema.Struct({
  logId: Schema.String.pipe(DurableTable.primaryKey),
  contextId: Schema.String.pipe(Schema.minLength(1)),
  message: Schema.String,
  createdAt: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
}).annotations({
  identifier: "firegrid.host.sessionLog.row",
  title: "Session log row",
})
export type SessionLogRow = Schema.Schema.Type<typeof SessionLogRowSchema>

export type SessionLogChannel = EgressChannel<typeof SessionLogRowSchema> & {
  readonly kind: "session.log"
  readonly storage: "durable-table"
}

export class SessionLogChannelTag extends Context.Tag(
  "firegrid/host-sdk/channels/session.log",
)<SessionLogChannelTag, SessionLogChannel>() {}

export const sessionLogChannel = (
  options: {
    readonly target?: ChannelTarget | string
    readonly append: (
      row: SessionLogRow,
    ) => Effect.Effect<void, unknown, never>
  },
): SessionLogChannel => {
  const channel = makeEgressChannel({
    target: options.target ?? SessionLogChannelTarget,
    schema: SessionLogRowSchema,
    // firegrid-agent-body-plan.SESSION_LOG.3
    append: options.append,
  })
  return {
    ...channel,
    kind: "session.log",
    storage: "durable-table",
  }
}

export const sessionLogChannelFromCollection = (
  options: {
    readonly target?: ChannelTarget | string
    readonly collection: Pick<
      DurableTableCollectionFacade<SessionLogRow, string>,
      "insert"
    >
  },
): SessionLogChannel =>
  sessionLogChannel({
    ...(options.target === undefined ? {} : { target: options.target }),
    append: row => options.collection.insert(row),
  })
