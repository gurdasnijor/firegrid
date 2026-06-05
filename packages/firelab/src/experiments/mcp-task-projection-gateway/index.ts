import { defineExperiment } from "../../types.ts"
import { adapterStartedAgent, sessionDroveWorkflow } from "../../runner/coverage.ts"
import { mcpTaskProjectionGatewayDriver } from "./driver.ts"
import { mcpTaskProjectionGatewayHost } from "./host.ts"

export default defineExperiment({
  id: "mcp-task-projection-gateway",
  description:
    "Exercises MCP Tasks for session_prompt with task state projected from existing RuntimeContext output, without a spike-local task store.",
  host: mcpTaskProjectionGatewayHost,
  driver: mcpTaskProjectionGatewayDriver,
  coverage: {
    gates: [
      sessionDroveWorkflow,
      adapterStartedAgent,
      {
        id: "session.spawned",
        description: "the gateway spawned a session for task-state projection",
        claim: "spans.exists(s, namedPrefix(s, \"unified.session.spawn/\"))",
      },
      {
        id: "agent.output_projected",
        description: "real agent session updates fed the projected task state",
        claim: "spans.exists(s, named(s, \"firegrid.agent_event_pipeline.acp.session_update\"))",
      },
    ],
  },
})
