import { defineSimulation } from "../../types.ts"
import { naturalExitTerminalDriver } from "./driver.ts"
import { naturalExitTerminalHost } from "./host.ts"

export default defineSimulation({
  id: "natural-exit-terminal",
  description:
    "tf-r06u.36: proves the natural process-exit path reaps the per-context "
    + "process. A real one-shot ACP agent answers one prompt then exits its "
    + "process; the host codec emits Terminated; the production observer "
    + "delivers a terminal input to the per-event RuntimeContext handler, which "
    + "runs adapter.deregister (Scope.close → reap). Driver is "
    + "@firegrid/client-sdk-only and never calls close/cancel. The trace is the "
    + "deliverable.",
  host: naturalExitTerminalHost,
  driver: naturalExitTerminalDriver,
})
