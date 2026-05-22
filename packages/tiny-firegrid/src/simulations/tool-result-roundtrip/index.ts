import { defineSimulation } from "../../types.ts"
import { toolRoundtripDriver } from "./driver.ts"
import { toolRoundtripHost } from "./workflow.ts"

export default defineSimulation({
  id: "tool-result-roundtrip",
  description:
    "tf-jt8q clean-room: agent ToolUse output -> idempotent tool result append -> TurnComplete over workflow-owned tables with a durable skip cursor; no ToolCallWorkflow or deferred mailbox. Proves exactly-once tool execution across replays and O(distinct outputs/results).",
  host: toolRoundtripHost,
  driver: toolRoundtripDriver,
})
