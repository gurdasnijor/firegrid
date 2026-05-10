import {
  MessageProjectionSchema,
  SessionProjectionSchema,
} from "./schema.ts"

export const sessionStateDescriptor = {
  sessions: {
    type: "firegrid.session",
    primaryKey: "sessionId",
    schema: SessionProjectionSchema,
  },
  messages: {
    type: "firegrid.session.message",
    primaryKey: "messageId",
    schema: MessageProjectionSchema,
  },
} as const
