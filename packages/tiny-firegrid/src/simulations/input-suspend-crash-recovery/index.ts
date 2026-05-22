import { defineSimulation } from "../../types.ts"
import { inputSuspendCrashRecoveryDriver } from "./driver.ts"
import { inputSuspendCrashRecoveryHost } from "./host.ts"

export default defineSimulation({
  id: "input-suspend-crash-recovery",
  description:
    "S1 (axis-2 durability gap): a body parked on Workflow.suspend waiting for a "
    + "workflow-owned table input is not re-armed by engine reconstruction "
    + "(only clock wakeups are), and write-row/engine.resume are untransacted. "
    + "Probes A (crash between write & resume) + B (restart while parked) + C "
    + "(clock auto-recovery contrast) over the real DurableStreamsWorkflowEngine.",
  host: inputSuspendCrashRecoveryHost,
  driver: inputSuspendCrashRecoveryDriver,
})
