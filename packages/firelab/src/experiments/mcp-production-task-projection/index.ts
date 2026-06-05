import { defineExperiment } from "../../types.ts"
import { adapterStartedAgent, sessionDroveWorkflow } from "../../runner/coverage.ts"
import { mcpProductionTaskProjectionDriver } from "./driver.ts"
import { mcpProductionTaskProjectionHost } from "./host.ts"

export default defineExperiment({
  id: "mcp-production-task-projection",
  description:
    "Drives session_prompt through the production FiregridMcpServerLayer "
    + "durable-streams transport and task-projection adapter, using real "
    + "claude-acp spawn/output/permission flow.",
  host: mcpProductionTaskProjectionHost,
  driver: mcpProductionTaskProjectionDriver,
  coverage: {
    gates: [
      sessionDroveWorkflow,
      adapterStartedAgent,
      {
        id: "session_prompt.dispatched",
        description: "session_prompt dispatched through the production MCP server layer",
        claim: "spans.exists(s, named(s, \"unified.mcp-tool-dispatch.execute\"))",
      },
      {
        id: "session.spawned",
        description: "the gateway spawned the task-projection session over durable-streams",
        claim: "spans.exists(s, namedPrefix(s, \"unified.session.spawn/\"))",
      },
    ],
  },
})
