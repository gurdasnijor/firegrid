import { Schema } from "effect"

export const SessionInputKindSchema = Schema.Literal(
  "message",
  "control",
  "tool_result",
  "required_action_result",
)
export type SessionInputKind = Schema.Schema.Type<typeof SessionInputKindSchema>

export const SessionInputAuthorSchema = Schema.Literal(
  "client",
  "workflow",
  "tool",
  "system",
)
export type SessionInputAuthor = Schema.Schema.Type<typeof SessionInputAuthorSchema>

export const PublicPromptRequestSchema = Schema.Struct({
  contextId: Schema.String,
  payload: Schema.Unknown,
  idempotencyKey: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record({
    key: Schema.String,
    value: Schema.String,
  })),
}).annotations({
  parseOptions: {
    onExcessProperty: "error",
  },
})
export type PublicPromptRequest = Schema.Schema.Type<typeof PublicPromptRequestSchema>

export const SessionInputRequestSchema = Schema.Struct({
  sessionInputId: Schema.optional(Schema.String),
  contextId: Schema.String,
  kind: SessionInputKindSchema,
  authoredBy: SessionInputAuthorSchema,
  payload: Schema.Unknown,
  idempotencyKey: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record({
    key: Schema.String,
    value: Schema.String,
  })),
})
export type SessionInputRequest = Schema.Schema.Type<typeof SessionInputRequestSchema>

// `SessionInputRowSchema` is the canonical input-fact wire schema. Delivery
// progress lives in the generic `effect-durable-operators.ConsumerCheckpointStore`
// stream, so this durable fact stream contains only provider-neutral session
// input facts.
export const SessionInputRowSchema = Schema.Struct({
  type: Schema.Literal("firegrid.session.input"),
  id: Schema.String,
  at: Schema.String,
  sessionInputId: Schema.String,
  contextId: Schema.String,
  kind: SessionInputKindSchema,
  authoredBy: SessionInputAuthorSchema,
  payload: Schema.Unknown,
  idempotencyKey: Schema.optional(Schema.String),
  createdAt: Schema.String,
  metadata: Schema.optional(Schema.Record({
    key: Schema.String,
    value: Schema.String,
  })),
})
export type SessionInputRow = Schema.Schema.Type<typeof SessionInputRowSchema>
