import { defineSimulation } from "../../types.ts"
import { makeMcpProductionTaskProjectionHost } from "../mcp-production-task-projection/host.ts"
import { mcpClientSdkObservationsDriver } from "./driver.ts"

const gatewayContextId = "session:tiny-firegrid:mcp-client-sdk-observations-parent"
const streamId = "mcp-client-sdk-observations"

export default defineSimulation({
  id: "mcp-client-sdk-observations",
  description:
    "Reads Firegrid context observations through @firegrid/client-sdk/mcp over "
    + "the production FiregridMcpServerLayer durable-streams transport, including "
    + "snapshot/watch and channel wait projections.",
  host: makeMcpProductionTaskProjectionHost({
    gatewayContextId,
    streamId,
  }),
  driver: mcpClientSdkObservationsDriver,
})
