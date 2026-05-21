import { defineSimulation } from "../../../types.ts"
import { sim1AgentOutputCollapseDriver } from "./driver.ts"
import { sim1AgentOutputCollapseHost } from "./host.ts"

export default defineSimulation({
  id: "sim1-agent-output-collapse",
  description:
    "Validates that SessionAgentOutputChannel can carry the same agent-output observations as the public session.wait.forAgentOutput path.",
  host: sim1AgentOutputCollapseHost,
  driver: sim1AgentOutputCollapseDriver,
})
