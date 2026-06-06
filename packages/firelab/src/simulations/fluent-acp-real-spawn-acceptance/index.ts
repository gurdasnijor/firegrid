import { defineSimulation } from "../../types.ts"
import { driver } from "./driver.ts"
import { host } from "./host.ts"

export default defineSimulation({
  id: "fluent-acp-real-spawn-acceptance",
  description:
    "Real-agent acceptance: spawns a REAL claude-code-acp process via @firegrid/fluent-acp-process, wires FiregridAcpClient over its stream, drives a real prompt turn, and records the agent's callbacks as durable L1/L2 fluent-runtime facts. Env-gated on ANTHROPIC_API_KEY; no fake fallback (F-A10).",
  host,
  driver,
  coverage: {
    // The verdict is computed from forge-proof host-substrate spans — the driver
    // draws no verdict. Load-bearing proof:
    //  1. a REAL keyed agent (claude) was spawned by the process owner;
    //  2. the agent's ACP callbacks were persisted as durable fluent-runtime
    //     facts over real Durable Streams.
    // A fake/arbitrary command fails gate 1 (agent != "claude"); a no-callback
    // run fails gate 2; both spans fire host-side (firegrid.side != "driver").
    gates: [
      {
        id: "fluent_acp_real_spawn.real_agent_spawned",
        description: "the process owner spawned the REAL claude ACP agent (not a fake command)",
        claim:
          "spans.exists(s, named(s, \"fluent-acp-process.spawn\") && attr(s, \"firegrid.acp_process.agent\") == \"claude\")",
      },
      {
        id: "fluent_acp_real_spawn.l1_append",
        description: "the real agent's ACP callbacks were persisted as L1 facts via FluentStore",
        claim: "spans.exists(s, named(s, \"fluent_runtime.store.session.append_event\"))",
      },
      {
        id: "fluent_acp_real_spawn.durable_write",
        description: "the L1 facts were written over real Durable Streams HTTP",
        claim: "spans.exists(s, named(s, \"firegrid.durable_streams.http.request\"))",
      },
    ],
    corroborations: [
      {
        id: "fluent_acp_real_spawn.host_ran",
        description: "the host spawned the real agent and drove the ACP turn",
        claim: "spans.exists(s, named(s, \"firegrid.sim.fluent_acp_real_spawn.host.run\"))",
      },
      {
        id: "fluent_acp_real_spawn.driver_observed",
        description: "the driver observed the persisted L1 facts on the session stream",
        claim: "spans.exists(s, named(s, \"firelab.fluent_acp_real_spawn.driver\"))",
      },
    ],
  },
})
