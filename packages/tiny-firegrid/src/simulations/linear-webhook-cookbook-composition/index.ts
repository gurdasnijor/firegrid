import { defineSimulation } from "../../types.ts"
import { linearWebhookCookbookDriver } from "./driver.ts"
import { linearWebhookCookbookHost } from "./host.ts"

export default defineSimulation({
  id: "linear-webhook-cookbook-composition",
  description:
    "Cookbook composition for the live external-trigger loop: a product-owned signed Linear webhook route writes verified webhook facts, the generic firegrid.verifiedWebhooks channel makes them wait_for-observable, and a deterministic planner waits on source/eventType/webhookId.",
  host: linearWebhookCookbookHost,
  driver: linearWebhookCookbookDriver,
})
