import { defineSimulation } from "../../types.ts"
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
})
