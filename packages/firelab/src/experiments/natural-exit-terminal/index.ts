import { defineExperiment } from "../../types.ts"
import { adapterStartedAgent } from "../../runner/coverage.ts"
import { naturalExitTerminalDriver } from "./driver.ts"
import { naturalExitTerminalHost } from "./host.ts"

export default defineExperiment({
  id: "natural-exit-terminal",
  description:
    "tf-r06u.36: proves the natural process-exit path reaps the per-context "
    + "process. A real one-shot ACP agent answers one prompt then exits its "
    + "process; the host codec emits Terminated; the production observer "
    + "delivers a terminal input to the per-event RuntimeContext handler, which "
    + "runs adapter.deregister (Scope.close → reap). Driver is "
    + "@firegrid/client-sdk-only and never calls close/cancel. The verdict is "
    + "computed by the coverage oracle over the host-substrate trace.",
  host: naturalExitTerminalHost,
  driver: naturalExitTerminalDriver,
  coverage: {
    gates: [
      adapterStartedAgent,
      {
        id: "process.exited",
        description: "the one-shot agent process exited on its own (natural exit)",
        claim: "spans.exists(s, named(s, \"firegrid.agent_event_pipeline.source.local_process.exit\"))",
      },
      {
        id: "codec.terminated",
        description: "the host codec emitted the ACP exit (Terminated)",
        claim: "spans.exists(s, named(s, \"firegrid.agent_event_pipeline.acp.exit\"))",
      },
      {
        id: "adapter.reaped",
        description: "the terminal input drove adapter.deregister (Scope.close → reap) — the driver never called close",
        claim: "spans.exists(s, named(s, \"firegrid.unified.adapter.deregister\"))",
      },
    ],
  },
})
