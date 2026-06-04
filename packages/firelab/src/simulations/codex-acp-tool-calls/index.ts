import { defineSimulation } from "../../types.ts"
import { adapterStartedAgent } from "../../runner/coverage.ts"
import { codexAcpToolCallDriver } from "./driver.ts"
import { codexAcpHost } from "./host.ts"

export default defineSimulation({
  id: "codex-acp-tool-calls",
  description:
    "Runs real Codex ACP over the durable-streams MCP ingress (session_new "
    + "child of the gateway runtime) against the unified host-owned "
    + "runtime-context MCP server, recording whether codex calls the Firegrid "
    + "`sleep` tool and emits the marker.",
  host: codexAcpHost,
  driver: codexAcpToolCallDriver,
  // CREDS-GATED: runs real Codex (needs OPENAI_API_KEY), so these gates were
  // authored from the shared ACP span shape, NOT verified against a live run in
  // this migration. Run with creds and `simulate seams codex-acp-tool-calls` to
  // confirm the verdict (and to add a sleep-tool-specific gate once the live
  // trace shows the tool.execute / tool_result span name + marker attribute).
  coverage: {
    gates: [
      adapterStartedAgent,
      {
        id: "codex.session_update",
        description: "real Codex emitted ACP session updates over the durable-streams ingress",
        claim: "spans.exists(s, named(s, \"firegrid.agent_event_pipeline.acp.session_update\"))",
      },
      {
        id: "sleep.tool_dispatched",
        description: "Codex's call to the Firegrid `sleep` tool dispatched on the host",
        claim: "spans.exists(s, namedPrefix(s, \"unified.tool.execute/\"))",
      },
    ],
  },
})
