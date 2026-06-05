import { defineExperiment } from "../../types.ts"
import { adapterStartedAgent, terminalSignalBeforeDeregister } from "../../runner/coverage.ts"
import { driver } from "./driver.ts"
import { host } from "./host.ts"

export default defineExperiment({
  id: "control-plane-cancel-close",
  description:
    "Probes the current public cancel/close session lifecycle surface and records whether it reaches a kernel terminal consumer.",
  host,
  driver,
  coverage: {
    gates: [
      adapterStartedAgent,
      {
        id: "session.terminal_signal",
        description: "cancel/close drove a session terminal signal (reached the kernel terminal consumer)",
        claim: "spans.exists(s, named(s, \"firegrid.unified.session.terminal_signal\"))",
      },
      {
        id: "adapter.deregister",
        description: "the terminal signal drove adapter deregistration",
        claim: "spans.exists(s, named(s, \"firegrid.unified.adapter.deregister\"))",
      },
      // Ordered, not just both-fired: terminal_signal precedes its deregister
      // (same context.id) — proves cancel/close reached the terminal consumer in order.
      terminalSignalBeforeDeregister,
      {
        id: "acp.clean_exit",
        description: "the agent process exited cleanly on close",
        claim: "spans.exists(s, named(s, \"firegrid.agent_event_pipeline.acp.exit\"))",
      },
    ],
  },
})
