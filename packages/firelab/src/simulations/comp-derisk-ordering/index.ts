import { defineSimulation } from "../../types.ts"
import { adapterStartedAgent, sessionDroveWorkflow } from "../../runner/coverage.ts"
import { compDeriskOrderingDriver } from "./driver.ts"
import { host } from "./host.ts"

export default defineSimulation({
  id: "comp-derisk-ordering",
  description:
    "tf-0awo.20 — §3.1/§12 Seam 1b output-ordering de-risk. Drives a real ACP "
    + "agent through the public client surface and records, via a host-scoped "
    + "observer over the host-wide RuntimeOutputTable.events projection, the "
    + "append order vs (activityAttempt, sequence) of output rows. Probes "
    + "whether a second output drain is reachable via close -> re-prompt. The "
    + "verdict is computed by the coverage oracle over the host-substrate trace.",
  host,
  driver: compDeriskOrderingDriver,
  coverage: {
    gates: [
      sessionDroveWorkflow,
      adapterStartedAgent,
      {
        id: "agent.output_observed",
        description: "the real ACP agent emitted a session update",
        claim: "spans.exists(s, named(s, \"firegrid.agent_event_pipeline.acp.session_update\"))",
      },
      {
        id: "output_order.probe_fired",
        description: "the host-scoped output-ordering observer recorded append order",
        claim: "spans.exists(s, named(s, \"firegrid.sim.output_order_probe\"))",
      },
      {
        id: "permission.roundtrip",
        description: "a permission roundtrip wrote its open-request row",
        claim: "spans.exists(s, namedPrefix(s, \"unified.permission.request/\"))",
      },
    ],
  },
})
