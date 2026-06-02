import { defineSimulation } from "../../types.ts"
import { verifiedWebhookWaitDriver } from "./driver.ts"
import {
  verifiedWebhookWaitChannels,
  verifiedWebhookWaitHost,
} from "./host.ts"

export default defineSimulation({
  id: "verified-webhook-wait",
  description:
    "Proves a product-owned signed Linear webhook route can write a verified fact that the public wait_for surface observes through firegrid.verifiedWebhooks.",
  host: verifiedWebhookWaitHost,
  channels: verifiedWebhookWaitChannels,
  launchHost: true,
  driver: verifiedWebhookWaitDriver,
})
