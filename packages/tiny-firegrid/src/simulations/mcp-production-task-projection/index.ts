import { defineSimulation } from "../../types.ts"
import { mcpProductionTaskProjectionDriver } from "./driver.ts"
import { mcpProductionTaskProjectionHost } from "./host.ts"

export default defineSimulation({
  id: "mcp-production-task-projection",
  description:
    "Drives session_prompt through the production FiregridMcpServerLayer "
    + "durable-streams transport and task-projection adapter, using real "
    + "claude-acp spawn/output/permission flow.",
  host: mcpProductionTaskProjectionHost,
  driver: mcpProductionTaskProjectionDriver,
})
