import { Schema } from "effect"
import { DurableTable } from "effect-durable-operators"

export const FlamecastTurn = Schema.Struct({
  turnId: Schema.String.pipe(DurableTable.primaryKey),
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
  messageId: Schema.String.pipe(DurableTable.primaryKey),
  sessionId: Schema.String,
  turnId: Schema.String,
  sequence: Schema.Number,
  at: Schema.String,
  role: Schema.Literal("user", "assistant"),
  text: Schema.String,
  wordCount: Schema.optional(Schema.Number),
})
export type FlamecastMessage = Schema.Schema.Type<typeof FlamecastMessage>

export const FlamecastAgentsWebhook = Schema.Struct({
  webhookId: Schema.String.pipe(DurableTable.primaryKey),
  sessionId: Schema.String,
  turnId: Schema.String,
  ordinal: Schema.Number,
  provider: Schema.Literal("flamecast-agents"),
  userMessage: Schema.String,
  assistantText: Schema.String,
  status: Schema.Literal("accepted", "processed", "failed"),
  acceptedAt: Schema.String,
  updatedAt: Schema.String,
  summary: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
})
export type FlamecastAgentsWebhook = Schema.Schema.Type<typeof FlamecastAgentsWebhook>

export const FlamecastSession = Schema.Struct({
  sessionId: Schema.String.pipe(DurableTable.primaryKey),
  title: Schema.String,
  status: Schema.Literal("running", "complete", "failed"),
  turnCount: Schema.Number,
  updatedAt: Schema.String,
})
export type FlamecastSession = Schema.Schema.Type<typeof FlamecastSession>

export class FlamecastTable extends DurableTable("flamecast", {
  turns: FlamecastTurn,
  messages: FlamecastMessage,
  agentWebhooks: FlamecastAgentsWebhook,
  sessions: FlamecastSession,
}) {}
