/**
 * Runtime-owned verified webhook fact table.
 *
 * Implements:
 *  - firegrid-verified-webhook-ingest.FACTS.1
 *  - firegrid-verified-webhook-ingest.FACTS.2
 *  - firegrid-verified-webhook-ingest.FACTS.3
 *  - firegrid-verified-webhook-ingest.WAIT_INTEGRATION.1
 */

import { DurableTable, type DurableTableService } from "effect-durable-operators"
import { Schema } from "effect"
import { VerifiedWebhookFactKeyEncoded } from "./keys.ts"

export interface VerifiedWebhookFactTableOptions {
  readonly streamUrl: string
  readonly contentType?: string
  readonly txTimeoutMs?: number
}

export const VerifiedWebhookFactSchema = Schema.Struct({
  factKey: VerifiedWebhookFactKeyEncoded.pipe(DurableTable.primaryKey),
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
})
export type VerifiedWebhookFact = Schema.Schema.Type<typeof VerifiedWebhookFactSchema>

const verifiedWebhookFactSchemas = {
  verifiedWebhookFacts: VerifiedWebhookFactSchema,
} as const

export class VerifiedWebhookFactTable extends DurableTable(
  "firegrid.verifiedWebhook",
  verifiedWebhookFactSchemas,
) {}

export type VerifiedWebhookFactTableService = DurableTableService<
  typeof verifiedWebhookFactSchemas
>

export const verifiedWebhookFactTableLayerOptions = (
  options: VerifiedWebhookFactTableOptions,
) => ({
  streamOptions: {
    url: options.streamUrl,
    contentType: options.contentType ?? "application/json",
  },
  txTimeoutMs: options.txTimeoutMs ?? 2_000,
})
