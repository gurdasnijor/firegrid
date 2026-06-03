import { defineSimulation } from "../../types.ts"
import { mcpProductionTaskProjectionHost } from "../mcp-production-task-projection/host.ts"
import { mcpClientSdkGatewayDriver } from "./driver.ts"

export default defineSimulation({
  id: "mcp-client-sdk-gateway",
  description:
    "Drives session_new/session_prompt through the production FiregridMcpServerLayer "
    + "durable-streams transport using @firegrid/client-sdk/mcp, including task "
    + "streaming and permission update.",
  host: mcpProductionTaskProjectionHost,
  driver: mcpClientSdkGatewayDriver,
})
