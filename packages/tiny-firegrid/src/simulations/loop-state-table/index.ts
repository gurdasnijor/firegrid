import { defineSimulation } from "../../types.ts"
import { loopStateTableDriver } from "./driver.ts"
import { loopStateTableHost } from "./workflow.ts"

export default defineSimulation({
  id: "loop-state-table",
  description:
    "tf-zjuf derisk for tf-aseo: durable workflow-owned loop-state row (cursors + pending permission sets) lets a skip output cursor avoid replay re-walk while permission request/response matching survives reloads.",
  host: loopStateTableHost,
  driver: loopStateTableDriver,
})
