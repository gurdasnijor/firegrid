import { defineSimulation } from "../../types.ts"
import { coordinationTopologyDriver } from "./driver.ts"
import { coordinationTopologyHost } from "./host.ts"

export default defineSimulation({
  id: "coordination-topology",
  description:
    "Runs monolithic, orchestrated-worker, and choreographed-peer coordination arms over Firegrid channels.",
  host: coordinationTopologyHost,
  driver: coordinationTopologyDriver,
})
