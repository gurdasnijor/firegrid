import { defineSimulation } from "../../types.ts"
import { kernelOwnedWriteArmDriver } from "./driver.ts"
import { kernelOwnedWriteArmHost } from "./host.ts"

export default defineSimulation({
  id: "kernel-owned-write-arm",
  description:
    "tf-c9r9 (target rearch shape): a runtime-context body parks on a "
    + "workflow-owned TABLE input (Workflow.suspend, no deferred mailbox); a "
    + "serialized host-kernel/controller owns 'write the input row + arm the "
    + "owning execution' as one durable fact and, on restart, replays only its "
    + "OWN pending write+arm facts (never a generic resume-all sweep). Probes A "
    + "(crash between write & arm) + B (arm issued, body unfinished) recover "
    + "through the kernel path with no driver re-drive; C proves a deferred-await "
    + "execution the kernel owns no fact for is left untouched by the replay. "
    + "Over the real DurableStreamsWorkflowEngine; no engine changes.",
  host: kernelOwnedWriteArmHost,
  driver: kernelOwnedWriteArmDriver,
})
