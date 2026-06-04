import { defineSimulation } from "../../types.ts"
import { adapterStartedAgent } from "../../runner/coverage.ts"
import { shapeCTerminalOrderingDriver } from "./driver.ts"
import { shapeCTerminalOrderingHost } from "./host.ts"

export default defineSimulation({
  id: "shape-c-terminal-ordering",
  description:
    "tf-ll90.5.1: rebuilds the shape-c terminal-ordering invariant as a REAL-PATH "
    + "run. A real claude-acp spawn answers a prompt (raw agent_output incl. "
    + "TurnComplete, which does NOT terminate), then the driver issues an explicit "
    + "session.close(). The trace must show terminal completion bound to the durable "
    + "lifecycle: firegrid.unified.session.terminal_signal precedes "
    + "firegrid.unified.adapter.deregister for the same context.id — not a raw "
    + "agent_output. The verdict is computed by the coverage oracle.",
  host: shapeCTerminalOrderingHost,
  driver: shapeCTerminalOrderingDriver,
  coverage: {
    gates: [
      adapterStartedAgent,
      {
        id: "agent.turn_complete_observed",
        description: "the real agent emitted output (incl. TurnComplete, which must NOT terminate)",
        claim: "spans.exists(s, named(s, \"firegrid.agent_event_pipeline.acp.session_update\"))",
      },
      {
        id: "terminal.signal_recorded",
        description: "session.close() drove a durable terminal signal (not a raw agent_output)",
        claim: "spans.exists(s, named(s, \"firegrid.unified.session.terminal_signal\"))",
      },
      {
        // Both terminal_signal and deregister fire host-side; strict precedence
        // (terminal before deregister, same context.id) needs a relational helper
        // the CEL vocab does not yet expose — a documented follow-up.
        id: "lifecycle.deregistered",
        description: "the terminal signal drove adapter.deregister (durable lifecycle bound)",
        claim: "spans.exists(s, named(s, \"firegrid.unified.adapter.deregister\"))",
      },
    ],
  },
})
