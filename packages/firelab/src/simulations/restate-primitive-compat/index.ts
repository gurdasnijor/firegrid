import { defineSimulation } from "../../types.ts"
import { restatePrimitiveCompatDriver } from "./driver.ts"

// No `coverage` spec by design — substrate workbench (`launchHost: false`): no
// Firegrid host, so the trace carries no host-substrate spans (all are
// `firegrid.side="driver"`, driving the durable substrate directly). A
// forge-proof gate has nothing to bind to; the deliverable is the prose finding
// per the methodology's substrate carve-out.
export default defineSimulation({
  id: "restate-primitive-compat",
  description:
    "Workbench simulation mapping Restate sdk-gen Operation/Future combinators "
    + "onto Firegrid's lower durable substrate and emitting trace evidence for compat gaps.",
  launchHost: false,
  driver: restatePrimitiveCompatDriver,
})
