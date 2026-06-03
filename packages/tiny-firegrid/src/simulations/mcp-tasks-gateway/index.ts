import { defineSimulation } from "../../types.ts"
import { mcpTasksGatewayDriver } from "./driver.ts"
import { mcpTasksGatewayHost } from "./host.ts"

export default defineSimulation({
  id: "mcp-tasks-gateway",
  description:
    "Exercises provisional MCP Tasks over a durable-streams transport, backed by Firegrid workflow state, for session_new/session_prompt lifecycle output and permission input.",
  host: mcpTasksGatewayHost,
  driver: mcpTasksGatewayDriver,
})
