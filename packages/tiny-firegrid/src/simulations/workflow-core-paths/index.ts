import { defineSimulation } from "../../types.ts"
import { workflowCorePathsDriver } from "./driver.ts"
import { workflowCorePathsHost } from "./host.ts"

export default defineSimulation({
  id: "workflow-core-paths",
  description:
    "Phase-1 substrate acceptance: drives wait_for against a pre-seeded caller-owned fact and leaves trace evidence for the workflow-native runtime/tool path.",
  host: workflowCorePathsHost,
  driver: workflowCorePathsDriver,
})
