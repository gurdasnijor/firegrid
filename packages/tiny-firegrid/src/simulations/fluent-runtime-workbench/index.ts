import { defineSimulation } from "../../types.ts"
import { fluentRuntimeWorkbenchDriver } from "./driver.ts"

// No `coverage` spec by design. This is a substrate workbench (`launchHost:
// false`): there is no Firegrid host, so the trace carries no host-substrate
// spans — the driver drives the durable-streams substrate directly and every
// span is `firegrid.side="driver"`. A forge-proof host-substrate gate has no
// span to bind to here, so faking one would be dishonest. Per the methodology's
// substrate carve-out, the deliverable is the prose finding (the trace is NOT
// public-seam evidence); the runner reports "no computed verdict".
export default defineSimulation({
  id: "fluent-runtime-workbench",
  description:
    "Workbench simulation for the new fluent-runtime managed-agent store: "
    + "session streams, turn append-and-close, closed read-back, and fork probing.",
  launchHost: false,
  driver: fluentRuntimeWorkbenchDriver,
})
