import { createStateSchema } from "@durable-streams/state"
import { Schema } from "effect"
import {
  MessageProjectionSchema,
  SessionProjectionSchema,
} from "./schema.ts"

export const sessionStateSchema = createStateSchema({
  sessions: {
    type: "firegrid.session",
    primaryKey: "sessionId",
    schema: Schema.standardSchemaV1(SessionProjectionSchema),
  },
  messages: {
    type: "firegrid.session.message",
    primaryKey: "messageId",
    schema: Schema.standardSchemaV1(MessageProjectionSchema),
  },
})
