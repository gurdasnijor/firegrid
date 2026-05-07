import { createStateSchema } from "@durable-streams/state"
import { Schema } from "effect"

export const FlamecastTurn = Schema.Struct({
  turnId: Schema.String,
  sessionId: Schema.String,
  ordinal: Schema.Number,
  message: Schema.String,
  status: Schema.Literal("submitted", "running", "completed", "failed"),
  submittedAt: Schema.String,
  updatedAt: Schema.String,
  summary: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
})
export type FlamecastTurn = Schema.Schema.Type<typeof FlamecastTurn>

export const FlamecastMessage = Schema.Struct({
  messageId: Schema.String,
  sessionId: Schema.String,
  turnId: Schema.String,
  sequence: Schema.Number,
  at: Schema.String,
  role: Schema.Literal("user", "assistant"),
  text: Schema.String,
  wordCount: Schema.optional(Schema.Number),
})
export type FlamecastMessage = Schema.Schema.Type<typeof FlamecastMessage>

export const FlamecastSession = Schema.Struct({
  sessionId: Schema.String,
  title: Schema.String,
  status: Schema.Literal("running", "complete", "failed"),
  turnCount: Schema.Number,
  updatedAt: Schema.String,
})
export type FlamecastSession = Schema.Schema.Type<typeof FlamecastSession>

export const flamecastState = createStateSchema({
  turns: {
    type: "flamecast.turn",
    primaryKey: "turnId",
    schema: Schema.standardSchemaV1(FlamecastTurn),
  },
  messages: {
    type: "flamecast.message",
    primaryKey: "messageId",
    schema: Schema.standardSchemaV1(FlamecastMessage),
  },
  sessions: {
    type: "flamecast.session",
    primaryKey: "sessionId",
    schema: Schema.standardSchemaV1(FlamecastSession),
  },
})
