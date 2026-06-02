import { defineSimulation } from "../../types.ts"
import { factoryCapstoneDriver } from "./driver.ts"
import { factoryCapstoneHost } from "./host.ts"

export default defineSimulation({
  id: "factory-capstone",
  description:
    "Runs a real ACP planner over the post-section-12 Firegrid runtime, binding darkFactory.facts as an app-owned wait_for stream and probing trigger-to-reviewed-action choreography.",
  host: factoryCapstoneHost,
  driver: factoryCapstoneDriver,
})
