import { defineSimulation } from "../../types.ts"
import { mcpTaskProjectionGatewayDriver } from "./driver.ts"
import { mcpTaskProjectionGatewayHost } from "./host.ts"

export default defineSimulation({
  id: "mcp-task-projection-gateway",
  description:
    "Exercises MCP Tasks for session_prompt with task state projected from existing RuntimeContext output, without a spike-local task store.",
  host: mcpTaskProjectionGatewayHost,
  driver: mcpTaskProjectionGatewayDriver,
})
