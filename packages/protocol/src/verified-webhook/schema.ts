import { Schema } from "effect"

export const VerifiedWebhookFactKeySchema = Schema.Tuple(
  Schema.String,
  Schema.String,
)
export type VerifiedWebhookFactKey = Schema.Schema.Type<
  typeof VerifiedWebhookFactKeySchema
>

export const VerifiedWebhookFactFields = {
  factKey: VerifiedWebhookFactKeySchema,
  source: Schema.String,
  externalEventKey: Schema.String,
  externalEntityKey: Schema.optional(Schema.String),
  eventType: Schema.String,
  receivedAt: Schema.String,
  verifiedAt: Schema.String,
  signatureScheme: Schema.String,
  payloadSha256: Schema.String,
  selectedHeaders: Schema.Record({
    key: Schema.String,
    value: Schema.String,
  }),
  payload: Schema.Unknown,
} as const

export const VerifiedWebhookFactSchema = Schema.Struct(
  VerifiedWebhookFactFields,
).annotations({
  identifier: "firegrid.verifiedWebhook.fact",
  title: "Verified webhook fact",
  description: "Protocol-owned verified webhook fact projection.",
})
export type VerifiedWebhookFact = Schema.Schema.Type<
  typeof VerifiedWebhookFactSchema
>

const LinearWebhookTimestampSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.greaterThanOrEqualTo(0),
)

export const LinearWebhookPayloadSchema = Schema.Struct({
  action: Schema.String,
  type: Schema.String,
  actor: Schema.optional(Schema.Unknown),
  createdAt: Schema.String,
  data: Schema.optional(Schema.Unknown),
  url: Schema.optional(Schema.String),
  updatedFrom: Schema.optional(Schema.Unknown),
  organizationId: Schema.optional(Schema.String),
  webhookTimestamp: LinearWebhookTimestampSchema,
  webhookId: Schema.String,
}).annotations({
  identifier: "firegrid.linearWebhook.payload",
  title: "Linear webhook payload",
  description: "Protocol-owned Linear webhook payload projection.",
})
export type LinearWebhookPayload = Schema.Schema.Type<
  typeof LinearWebhookPayloadSchema
>

// firegrid-linear-webhook-fact-schema.PROTOCOL_SCHEMA.2
// firegrid-linear-webhook-fact-schema.LINEAR_FIELDS.1
// firegrid-linear-webhook-fact-schema.LINEAR_FIELDS.2
export const LinearWebhookFactFields = {
  ...VerifiedWebhookFactFields,
  payload: LinearWebhookPayloadSchema,
  action: Schema.String,
  type: Schema.String,
  webhookId: Schema.String,
  webhookTimestamp: LinearWebhookTimestampSchema,
  createdAt: Schema.String,
  organizationId: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  actor: Schema.optional(Schema.Unknown),
  data: Schema.optional(Schema.Unknown),
  updatedFrom: Schema.optional(Schema.Unknown),
} as const

export const LinearWebhookFactSchema = Schema.Struct(
  LinearWebhookFactFields,
).annotations({
  identifier: "firegrid.linearWebhook.fact",
  title: "Linear webhook fact",
  description: "Protocol-owned Linear verified webhook fact projection.",
})
export type LinearWebhookFact = Schema.Schema.Type<
  typeof LinearWebhookFactSchema
>
