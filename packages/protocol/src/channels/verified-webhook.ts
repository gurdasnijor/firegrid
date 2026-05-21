import { Context } from "effect"
import type { Schema } from "effect"
import type {
  VerifiedWebhookFactSchema,
} from "../verified-webhook/index.ts"
import {
  makeChannelTarget,
  type ChannelTarget,
  type IngressChannel,
} from "./core.ts"

// firegrid-verified-webhook-ingest.WAIT_INTEGRATION.2
export const VerifiedWebhookFactChannelTarget: ChannelTarget =
  makeChannelTarget("firegrid.verifiedWebhooks")

export type VerifiedWebhookFactChannelService =
  IngressChannel<Schema.Schema.Any>

export type VerifiedWebhookFactChannelRegistration =
  IngressChannel<typeof VerifiedWebhookFactSchema>

export class VerifiedWebhookFactChannel extends Context.Tag(
  "firegrid/protocol/channels/firegrid.verifiedWebhooks",
)<VerifiedWebhookFactChannel, VerifiedWebhookFactChannelService>() {}
