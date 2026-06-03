import { defineSimulation } from "../../types.ts"
import { shapeCTerminalOrderingDriver } from "./driver.ts"
import {
  shapeCTerminalOrderingChannels,
  shapeCTerminalOrderingHost,
} from "./host.ts"

export default defineSimulation({
  id: "shape-c-terminal-ordering",
  description:
    "tf-ll90.5.1: rebuilds the shape-c terminal-ordering invariant as a REAL-PATH "
    + "run. A real claude-acp spawn answers a prompt (raw agent_output incl. "
    + "TurnComplete, which does NOT terminate), then the driver issues an explicit "
    + "session.close(). The trace must show terminal completion bound to the durable "
    + "lifecycle: firegrid.unified.session.terminal_signal precedes "
    + "firegrid.unified.adapter.deregister for the same context.id — not a raw "
    + "agent_output. The trace is the deliverable.",
  host: shapeCTerminalOrderingHost,
  channels: shapeCTerminalOrderingChannels,
  driver: shapeCTerminalOrderingDriver,
})
