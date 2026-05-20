/**
 * Runtime-owned verified webhook fact table.
 *
 * Implements:
 *  - firegrid-verified-webhook-ingest.FACTS.1
 *  - firegrid-verified-webhook-ingest.FACTS.2
 *  - firegrid-verified-webhook-ingest.FACTS.3
 *  - firegrid-verified-webhook-ingest.WAIT_INTEGRATION.1
 */

import {
  DurableTable,
  type DurableTableHeaders,
  type DurableTableLayerOptions,
  type DurableTableService,
} from "effect-durable-operators"
import { Schema } from "effect"
import {
  VerifiedWebhookFactFields,
  VerifiedWebhookFactSchema,
  type VerifiedWebhookFact,
} from "@firegrid/protocol/verified-webhook"
import { VerifiedWebhookFactKeyEncoded } from "./keys.ts"

export { VerifiedWebhookFactSchema, type VerifiedWebhookFact }

export interface VerifiedWebhookFactTableOptions {
  readonly streamUrl: string
  readonly contentType?: string
  readonly headers?: DurableTableHeaders
  readonly txTimeoutMs?: number
}

const VerifiedWebhookFactTableRowSchema = Schema.Struct({
  ...VerifiedWebhookFactFields,
  factKey: VerifiedWebhookFactKeyEncoded.pipe(DurableTable.primaryKey),
})

const verifiedWebhookFactSchemas = {
  verifiedWebhookFacts: VerifiedWebhookFactTableRowSchema,
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
): DurableTableLayerOptions => {
  const contentType = options.contentType ?? "application/json"
  const streamOptions = options.headers === undefined
    ? { url: options.streamUrl, contentType }
    : { url: options.streamUrl, contentType, headers: options.headers }

  return {
    streamOptions,
    txTimeoutMs: options.txTimeoutMs ?? 2_000,
  }
}
