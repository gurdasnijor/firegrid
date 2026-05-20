import { defineSimulation } from "../../types.ts"
import { darkFactoryDriver } from "./driver.ts"
import { darkFactoryHost } from "./host.ts"

export default defineSimulation({
  id: "dark-factory",
  description:
    "Launches a real ACP planner with Firegrid runtime-context MCP, binds app-owned darkFactory.facts as a CallerFact stream, seeds the edge trigger fact, and observes the factory-vision section 6 loop without an app-authored phase chain.",
  host: darkFactoryHost,
  driver: darkFactoryDriver,
})
