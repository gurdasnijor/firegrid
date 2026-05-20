import { defineSimulation } from "../../types.ts"
import { inv2LayeredDriver } from "./driver.ts"
import { inv2LayeredHost, type Inv2LayeredHostOptions } from "./host.ts"

const hostOptions: Inv2LayeredHostOptions = {
  mcpHost: "127.0.0.1",
  mcpPort: 14774,
  mcpPath: "/mcp",
}

export default defineSimulation({
  id: "inv2-waitforworkflow-layered",
  description:
    "INV-2 PATH A AMENDMENT: SAME WaitForWorkflow body as `inv2-waitforworkflow` but the R-discharge for `WorkflowEngine` uses LAYER COMPOSITION (Tool.dependencies declares the engine; host composition provides via Layer.provideMerge) — the @effect/workflow-canonical shape (cf. WorkflowEngine.test.ts:14-23). NO closure capture in the handler.",
  host: (env) => inv2LayeredHost(env, hostOptions),
  driver: inv2LayeredDriver(hostOptions),
})
