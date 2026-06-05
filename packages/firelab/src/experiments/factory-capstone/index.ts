import { defineExperiment } from "../../types.ts"
import { adapterStartedAgent, sessionDroveWorkflow } from "../../runner/coverage.ts"
import { factoryCapstoneDriver } from "./driver.ts"
import { factoryCapstoneHost } from "./host.ts"

export default defineExperiment({
  id: "factory-capstone",
  description:
    "Runs a real ACP planner over the post-section-12 Firegrid runtime, binding darkFactory.facts as an app-owned wait_for stream and probing trigger-to-reviewed-action choreography.",
  host: factoryCapstoneHost,
  driver: factoryCapstoneDriver,
  coverage: {
    gates: [
      sessionDroveWorkflow,
      adapterStartedAgent,
      {
        id: "planner.session_spawned",
        description: "the real ACP planner session spawned on the host",
        claim: "spans.exists(s, namedPrefix(s, \"unified.session.spawn/\"))",
      },
      {
        id: "choreography.tool_dispatched",
        description: "trigger-to-reviewed-action choreography dispatched an MCP tool",
        claim: "spans.exists(s, named(s, \"unified.mcp-tool-dispatch.execute\"))",
      },
    ],
  },
})
