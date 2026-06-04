import { defineSimulation } from "../../types.ts"
import { fluentRuntimeWorkbenchDriver } from "./driver.ts"

export default defineSimulation({
  id: "fluent-runtime-workbench",
  description:
    "Workbench simulation for the new fluent-runtime managed-agent store: "
    + "session streams, turn append-and-close, closed read-back, and fork probing.",
  launchHost: false,
  driver: fluentRuntimeWorkbenchDriver,
})
