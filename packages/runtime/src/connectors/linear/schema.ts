import { Schema } from "effect"
import type { ExternalIngressFactBase } from "../../capabilities/external-ingress-appender.ts"

/**
 * The minimal Linear webhook payload shape the spike decodes. Linear
 * sends a richer body in production; the spike narrows to the fields the
 * journaling step actually uses, so a wider payload still decodes
 * successfully thanks to `Schema.Struct`'s extra-property tolerance.
 */
export const LinearWebhookPayloadSchema = Schema.Struct({
  action: Schema.String,
  type: Schema.String,
  webhookId: Schema.String,
  webhookTimestamp: Schema.Number,
  createdAt: Schema.String,
  organizationId: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
  actor: Schema.optional(Schema.Unknown),
  updatedFrom: Schema.optional(Schema.Unknown),
})
export type LinearWebhookPayload = Schema.Schema.Type<typeof LinearWebhookPayloadSchema>

/**
 * Typed event the connector emits from one inbound request. For Linear
 * this is the parsed webhook payload plus the receipt metadata; the
 * `journal` step turns it into a row.
 */
export const LinearEventSchema = Schema.Struct({
  payload: LinearWebhookPayloadSchema,
  receivedAt: Schema.String,
  verifiedAt: Schema.String,
  payloadSha256: Schema.String,
  rawBodyBytes: Schema.Number,
})
export type LinearEvent = Schema.Schema.Type<typeof LinearEventSchema>

/**
 * The fact row Linear's writer journals. Includes the
 * `ExternalIngressFactBase` fields plus Linear-specific extras.
 */
export const LinearFactSchema = Schema.Struct({
  factKey: Schema.Tuple(Schema.String, Schema.String),
  source: Schema.String,
  externalEventKey: Schema.String,
  eventType: Schema.String,
  receivedAt: Schema.String,
  verifiedAt: Schema.String,
  payloadSha256: Schema.String,
  action: Schema.String,
  type: Schema.String,
  webhookId: Schema.String,
  webhookTimestamp: Schema.Number,
  createdAt: Schema.String,
  organizationId: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
  actor: Schema.optional(Schema.Unknown),
  updatedFrom: Schema.optional(Schema.Unknown),
})
export type LinearFact = Schema.Schema.Type<typeof LinearFactSchema>

// Static check that LinearFact satisfies the appender's base contract.
const _factBaseCheck: ExternalIngressFactBase = {} as LinearFact
void _factBaseCheck
