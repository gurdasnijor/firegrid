import { defineSimulation } from "../../types.ts"
import { controlPlaneCancelCloseDriver } from "./driver.ts"
import { controlPlaneCancelCloseHost } from "./host.ts"

export default defineSimulation({
  id: "control-plane-cancel-close",
  description:
    "Deterministic, keyless control-plane lifecycle probe: a stdio-jsonl parent agent creates a child session and drives it through session_cancel, a resume-after-cancel prompt, and session_close via the agent-tool surface, exercising the host control-request dispatcher / RuntimeLifecycleWorkflow / runtime-control path.",
  host: controlPlaneCancelCloseHost,
  driver: controlPlaneCancelCloseDriver,
})
