import { defineSimulation } from "../../types.ts"
import { runtimeContextFactMatrixDriver } from "./driver.ts"
import { runtimeContextFactMatrixHost } from "./workflow.ts"

export default defineSimulation({
  id: "runtime-context-fact-matrix",
  description:
    "tf-u8w2 proof for tf-tvg1: input / output-transition / permission-response / tool-result / terminal facts all route by stable identity (contextId) to the per-key RuntimeContext subscriber. State advances from sparse facts only — dense raw TextChunk output is a separate UI/telemetry stream the subscriber never scans — and permission/tool correlation is by id, not arrival order, with no cross-event DurableDeferred mailbox.",
  host: runtimeContextFactMatrixHost,
  driver: runtimeContextFactMatrixDriver,
})
