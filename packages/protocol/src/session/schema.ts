import { Schema } from "effect"

export const SessionStatusSchema = Schema.Literal("active", "completed", "failed")
export type SessionStatus = Schema.Schema.Type<typeof SessionStatusSchema>

export const SessionRoleSchema = Schema.Literal("assistant", "user", "system", "tool")
export type SessionRole = Schema.Schema.Type<typeof SessionRoleSchema>

export const SessionProjectionSchema = Schema.Struct({
  sessionId: Schema.String,
  contextId: Schema.String,
  status: SessionStatusSchema,
})
export type SessionProjection = Schema.Schema.Type<typeof SessionProjectionSchema>

export const MessageProjectionSchema = Schema.Struct({
  messageId: Schema.String,
  sessionId: Schema.String,
  contextId: Schema.String,
  role: SessionRoleSchema,
  text: Schema.String,
  sourceRuntimeEventId: Schema.String,
  createdAt: Schema.String,
})
export type MessageProjection = Schema.Schema.Type<typeof MessageProjectionSchema>
