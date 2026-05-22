import { defineSimulation } from "../../types.ts"
import { tinyInputAppendWakeupDriver } from "./driver.ts"
import { tinyInputAppendWakeupHost } from "./host.ts"

export default defineSimulation({
  id: "tiny-input-append-wakeup",
  description:
    "tf-64lq Phase 0C proof: atomic workflow input append, inputIds idempotency, point-addressed inputKey reads, and a minimal table-write wakeup.",
  host: tinyInputAppendWakeupHost,
  driver: tinyInputAppendWakeupDriver,
})
