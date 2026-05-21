import { defineSimulation } from "../../types.ts"
import { agenticPatternsPrimitiveProfileDriver } from "./driver.ts"
import { agenticPatternsPrimitiveProfileHost } from "./host.ts"

export default defineSimulation({
  id: "agentic-patterns-primitive-profile",
  description:
    "Showcases the ergonomic public session launch path with the locked Firegrid primitive MCP profile.",
  host: agenticPatternsPrimitiveProfileHost,
  driver: agenticPatternsPrimitiveProfileDriver,
})
