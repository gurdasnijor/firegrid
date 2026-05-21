import { defineSimulation } from "../../types.ts"
import { coordinationTopologyDriver } from "./driver.ts"
import { coordinationTopologyHost } from "./host.ts"

export default defineSimulation({
  id: "coordination-topology",
  description:
    "Runs the live frontier-model single/orchestration/choreography experiment, with fixture-smoke fallback.",
  host: coordinationTopologyHost,
  driver: coordinationTopologyDriver,
})
