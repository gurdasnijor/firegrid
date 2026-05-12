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

// `RuntimeIngressRowSchema` is the input-fact wire schema. Historically it
// was a Union including a `firegrid.runtime_ingress.accepted` member;
// delivery progress now lives in a separate
// `effect-durable-operators.ConsumerCheckpointStore`-backed stream (see
// docs/proposals/SDD_EFFECT_DURABLE_OPERATORS.md), so the row family has
// collapsed to the single `requested` member. The transitional
// `runtime_ingress.requested` type is still the public input fact;
// renaming to `firegrid.session.input` is a separate decision.
export const RuntimeIngressRowSchema = Schema.Struct({
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
export type RuntimeIngressRow = Schema.Schema.Type<typeof RuntimeIngressRowSchema>

// Historical type alias: callers that distinguished "requested" from
// the now-removed "accepted" member referenced this name.
export type RuntimeIngressRequestedRow = RuntimeIngressRow
