import { defineSimulation } from "../../types.ts"
import { runtimeToolUseExecutorContractDriver } from "./driver.ts"
import { runtimeToolUseExecutorContractHost } from "./host.ts"

export default defineSimulation({
  id: "runtime-tool-use-executor-contract",
  description:
    "Contract-level RuntimeToolUseExecutor adversarial probe: workflow-side"
    + " versus codec-side timeout, workflow scope cancellation, and duplicate"
    + " toolUseId behavior across same and retry activity attempts.",
  host: runtimeToolUseExecutorContractHost,
  driver: runtimeToolUseExecutorContractDriver,
})
