import { defineSimulation } from "../../types.ts"
import { inv2WaitForWorkflowDriver } from "./driver.ts"
import { inv2WaitForWorkflowHost, type Inv2HostOptions } from "./host.ts"

const hostOptions: Inv2HostOptions = {
  mcpHost: "127.0.0.1",
  mcpPort: 14773,
  mcpPath: "/mcp",
}

export default defineSimulation({
  id: "inv2-waitforworkflow",
  description:
    "INV-2 (SDD One-Substrate Steps 2-3): dispatches the agent's `wait_for` tool calls as nested `WaitForWorkflow` executions (DurableDeferred.raceAll[Activity(Stream.runHead(filter)), DurableClock.sleep]) — NO production wait-router involvement.",
  host: (env) => inv2WaitForWorkflowHost(env, hostOptions),
  driver: inv2WaitForWorkflowDriver(hostOptions),
})
