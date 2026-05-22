import { defineSimulation } from "../../types.ts"
import { perKeySubscriberDriver } from "./driver.ts"
import { perKeySubscriberHost } from "./host.ts"

export default defineSimulation({
  id: "per-key-subscriber-push-restart",
  description:
    "tf-4fy3 proof for tf-tvg1: can substrate-native push/tail (DurableTable.rows()) route durable event rows to a per-key keyed subscriber with per-key serialization and restart recovery, with no polling, no external write+arm, and no context-lifetime parked body? Reports A/B/C.",
  host: perKeySubscriberHost,
  driver: perKeySubscriberDriver,
})
