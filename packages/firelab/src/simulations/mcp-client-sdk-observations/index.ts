import { defineSimulation } from "../../types.ts"
import { adapterStartedAgent, sessionDroveWorkflow } from "../../runner/coverage.ts"
import { mcpClientSdkObservationsDriver } from "./driver.ts"
import { host } from "./host.ts"

export default defineSimulation({
  id: "mcp-client-sdk-observations",
  description:
    "Reads Firegrid context observations through @firegrid/client-sdk/mcp over "
    + "the production FiregridMcpServerLayer durable-streams transport, including "
    + "snapshot/watch and channel wait projections.",
  host,
  driver: mcpClientSdkObservationsDriver,
  coverage: {
    gates: [
      sessionDroveWorkflow,
      adapterStartedAgent,
      {
        id: "session.spawned",
        description: "the gateway spawned the observed session over durable-streams",
        claim: "spans.exists(s, namedPrefix(s, \"unified.session.spawn/\"))",
      },
      {
        id: "mcp_tool.dispatched",
        description: "the observation drove a real MCP tool dispatch on the host",
        claim: "spans.exists(s, named(s, \"unified.mcp-tool-dispatch.execute\"))",
      },
    ],
  },
})
