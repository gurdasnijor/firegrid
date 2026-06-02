import { defineSimulation } from "../../types.ts"
import { perEventRuntimeContextDriver } from "./driver.ts"
import { perEventRuntimeContextHost } from "./host.ts"

export default defineSimulation({
  id: "per-event-runtime-context",
  description:
    "Workbench (tf-c71h): proves the load-bearing RuntimeContext session loop "
    + "can adopt the PER-EVENT fresh-execution shape (the PermissionRoundtrip "
    + "shape generalized to many inputs per key). The driver uses only "
    + "@firegrid/client-sdk; the host composes the real FiregridRuntime factory "
    + "and overrides only the inbound session-input channels to route each input "
    + "to a fresh per-event handler execution over a durable cursor, leaving the "
    + "parked RuntimeContextSessionWorkflow registered-but-dormant.",
  host: perEventRuntimeContextHost,
  driver: perEventRuntimeContextDriver,
})
