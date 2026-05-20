import { defineSimulation } from "../../types.ts"
import { workflowCorePathsDriver } from "./driver.ts"
import { workflowCorePathsHost } from "./host.ts"

export default defineSimulation({
  id: "workflow-core-paths",
  description:
    "Exercises runtime-context agent-output waits plus the wait_for agent-tool lowering against one pre-seeded caller-owned fact, producing trace evidence for workflow-core wait-router decisions.",
  host: workflowCorePathsHost,
  driver: workflowCorePathsDriver,
})
