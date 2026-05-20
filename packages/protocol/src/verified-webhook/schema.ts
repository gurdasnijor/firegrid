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
