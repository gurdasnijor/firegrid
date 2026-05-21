import { defineSimulation } from "../../types.ts"
import { targetArchitectureReferenceDriver } from "./driver.ts"
import { targetArchitectureReferenceHost } from "./workflow.ts"

export default defineSimulation({
  id: "target-architecture-reference",
  description:
    "tf-ly2g Phase 0B: workflow-owned output append log, durable output cursor, result return, and O(outputs) observation.",
  host: targetArchitectureReferenceHost,
  driver: targetArchitectureReferenceDriver,
})
