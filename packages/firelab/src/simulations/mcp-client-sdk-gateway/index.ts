import { defineSimulation } from "../../types.ts"
import { adapterStartedAgent, sessionDroveWorkflow } from "../../runner/coverage.ts"
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
  coverage: {
    gates: [
      sessionDroveWorkflow,
      adapterStartedAgent,
      {
        id: "session_new.dispatched",
        description: "session_new dispatched through the production MCP server layer",
        claim: "spans.exists(s, named(s, \"unified.mcp-tool-dispatch.execute\"))",
      },
      {
        id: "session.spawned",
        description: "the gateway spawned a session over the durable-streams transport",
        claim: "spans.exists(s, namedPrefix(s, \"unified.session.spawn/\"))",
      },
    ],
  },
})
