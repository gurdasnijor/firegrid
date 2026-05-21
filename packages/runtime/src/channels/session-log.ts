import type {
  DurableTableCollectionFacade,
} from "effect-durable-operators"
import type { Effect } from "effect"
import {
  makeEgressChannel,
  type ChannelTarget,
} from "@firegrid/protocol/channels"
import {
  SessionLogChannelTarget,
  SessionLogRowSchema,
  type SessionLogChannel,
  type SessionLogRow,
} from "@firegrid/protocol/channels"

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
