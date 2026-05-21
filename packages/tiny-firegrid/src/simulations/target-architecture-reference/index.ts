import { defineSimulation } from "../../types.ts"
import { targetArchitectureReferenceDriver } from "./driver.ts"
import { targetArchitectureReferenceHost } from "./workflow.ts"

export default defineSimulation({
  id: "target-architecture-reference",
  description:
    "tf-pzsl Phase 0A: channel dispatch writes a workflow-owned DurableTable, the workflow reads rows and advances a durable cursor.",
  host: targetArchitectureReferenceHost,
  driver: targetArchitectureReferenceDriver,
})
