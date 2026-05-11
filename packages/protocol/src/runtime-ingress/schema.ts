import { Schema } from "effect"

export const RuntimeIngressKindSchema = Schema.Literal(
  "message",
  "control",
  "tool_result",
  "required_action_result",
)
export type RuntimeIngressKind = Schema.Schema.Type<typeof RuntimeIngressKindSchema>

export const RuntimeIngressAuthorSchema = Schema.Literal(
  "client",
  "workflow",
  "tool",
  "system",
)
export type RuntimeIngressAuthor = Schema.Schema.Type<typeof RuntimeIngressAuthorSchema>

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

export const RuntimeIngressRequestSchema = Schema.Struct({
  ingressId: Schema.optional(Schema.String),
  contextId: Schema.String,
  kind: RuntimeIngressKindSchema,
  authoredBy: RuntimeIngressAuthorSchema,
  payload: Schema.Unknown,
  idempotencyKey: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record({
    key: Schema.String,
    value: Schema.String,
  })),
})
export type RuntimeIngressRequest = Schema.Schema.Type<typeof RuntimeIngressRequestSchema>

export const RuntimeIngressRequestedRowSchema = Schema.Struct({
  type: Schema.Literal("firegrid.runtime_ingress.requested"),
  id: Schema.String,
  at: Schema.String,
  ingressId: Schema.String,
  contextId: Schema.String,
  kind: RuntimeIngressKindSchema,
  authoredBy: RuntimeIngressAuthorSchema,
  payload: Schema.Unknown,
  idempotencyKey: Schema.optional(Schema.String),
  createdAt: Schema.String,
  metadata: Schema.optional(Schema.Record({
    key: Schema.String,
    value: Schema.String,
  })),
})
export type RuntimeIngressRequestedRow = Schema.Schema.Type<
  typeof RuntimeIngressRequestedRowSchema
>

export const RuntimeIngressAcceptanceRequestSchema = Schema.Struct({
  contextId: Schema.String,
  ingressId: Schema.String,
  subscriberId: Schema.String,
  provider: Schema.String,
  acceptedAt: Schema.optional(Schema.String),
})
export type RuntimeIngressAcceptanceRequest = Schema.Schema.Type<
  typeof RuntimeIngressAcceptanceRequestSchema
>

export const RuntimeIngressAcceptedRowSchema = Schema.Struct({
  type: Schema.Literal("firegrid.runtime_ingress.accepted"),
  id: Schema.String,
  at: Schema.String,
  ingressId: Schema.String,
  contextId: Schema.String,
  subscriberId: Schema.String,
  provider: Schema.String,
  acceptedAt: Schema.String,
})
export type RuntimeIngressAcceptedRow = Schema.Schema.Type<
  typeof RuntimeIngressAcceptedRowSchema
>

export const RuntimeIngressRowSchema = Schema.Union(
  RuntimeIngressRequestedRowSchema,
  RuntimeIngressAcceptedRowSchema,
)
export type RuntimeIngressRow = Schema.Schema.Type<typeof RuntimeIngressRowSchema>
