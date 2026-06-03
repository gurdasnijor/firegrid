import { defineSimulation } from "../../types.ts"
import { mcpDurableStreamsGatewayDriver } from "./driver.ts"
import { mcpDurableStreamsGatewayHost } from "./host.ts"

export default defineSimulation({
  id: "mcp-durable-streams-gateway",
  description:
    "Runs Firegrid MCP tools over a custom Durable Streams Effect RPC protocol and probes whether client session lifecycle, output streaming, and permission response fit that ingress.",
  host: mcpDurableStreamsGatewayHost,
  driver: mcpDurableStreamsGatewayDriver,
})
