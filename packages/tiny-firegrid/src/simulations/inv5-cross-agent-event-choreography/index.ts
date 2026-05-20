import { defineSimulation } from "../../types.ts"
import { inv5ChoreographyDriver } from "./driver.ts"
import { inv5ChoreographyHost } from "./host.ts"

export default defineSimulation({
  id: "inv5-cross-agent-event-choreography",
  description:
    "Two claude-agent-acp processes coordinate indirectly via a shared"
    + " inv5.events CallerFact stream: one emits event('plan.ready') via a"
    + " sim-local emit_event MCP tool, the other wait_for's the same event."
    + " Validates body-plan SDD Slice C.2 (event(name) peer pheromone) and"
    + " the SMI-1992 choreography thesis empirically — no orchestrator code"
    + " mediates between the two agents.",
  host: inv5ChoreographyHost,
  driver: inv5ChoreographyDriver,
})
