import { defineSimulation } from "../../types.ts"
import { mcpClientSdkGatewayDriver } from "./driver.ts"
import { host } from "./host.ts"

export default defineSimulation({
  id: "mcp-client-sdk-gateway",
  description:
    "Drives session_new/session_prompt through the production FiregridMcpServerLayer "
    + "durable-streams transport using @firegrid/client-sdk/mcp, including task "
    + "streaming and permission update.",
  host,
  driver: mcpClientSdkGatewayDriver,
})
