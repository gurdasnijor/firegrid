import { defineSimulation } from "../../../types.ts"
import { sim1AgentOutputCollapseDriver } from "./driver.ts"
import { sim1AgentOutputCollapseHost } from "./host.ts"

export default defineSimulation({
  id: "sim1-agent-output-collapse",
  description:
    "Validates that SessionAgentOutputChannel can collapse session.wait.forAgentOutput, RuntimeAgentOutputAfterEvents.forContext, and raw RuntimeOutputTable.events.rows for agent-output observation.",
  host: sim1AgentOutputCollapseHost,
  driver: sim1AgentOutputCollapseDriver,
})
