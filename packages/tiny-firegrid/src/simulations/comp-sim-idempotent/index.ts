import { defineSimulation } from "../../types.ts"
import { sessionDroveWorkflow } from "../../runner/coverage.ts"
import { driver } from "./driver.ts"
import { host } from "./host.ts"

export default defineSimulation({
  id: "comp-sim-idempotent",
  description:
    "cap-3 / §7.3 — idempotent one-intent -> one-participant over the public MCP "
    + "client surface (mcp.sessions.createOrLoad = the session_create_or_load tool, "
    + "keyed by caller external [source, id]). Same key (incl. concurrent "
    + "redeliveries) collapses to one participant contextId; a different key stays "
    + "distinct. The verdict is computed by the coverage oracle over the "
    + "host-substrate trace (per-call insert_or_get + mcp-tool dispatch spans).",
  host,
  driver,
  coverage: {
    gates: [
      sessionDroveWorkflow,
      {
        id: "mcp_tool.dispatched",
        description: "the production MCP tool-dispatch workflow ran",
        claim: "spans.exists(s, named(s, \"unified.mcp-tool-dispatch.execute\"))",
      },
      {
        id: "create_or_load.executed",
        description: "session_create_or_load executed on the host (idempotent key resolution)",
        claim: "spans.exists(s, namedPrefix(s, \"unified.mcp-tool.execute/\"))",
      },
      {
        id: "insert_or_get.ran",
        description: "the durable insert-or-get keyed the participant contextId",
        claim: "spans.exists(s, named(s, \"firegrid.durable_table.insert_or_get\"))",
      },
    ],
  },
})
