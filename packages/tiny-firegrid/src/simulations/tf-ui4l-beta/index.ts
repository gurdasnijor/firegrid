import { defineSimulation } from "../../types.ts"
import { tfUi4lBetaDriver } from "./driver.ts"
import { tfUi4lBetaHost } from "./host.ts"

export default defineSimulation({
  id: "tf-ui4l-beta",
  description:
    "tf-ui4l/INV-6 shape β: Activity.subscribed sugar with (event) => Effect<Option<A>> termination (per OLA-2026-05-20 Q3). Sugar layer drives the CallerFact stream, calls the handler per event, writes a durable last-ack cursor per event (stands in for engine-owned subscription state), and terminates when handler returns Option.some. Compare against tf-ui4l-baseline: per-event durability cost.",
  host: tfUi4lBetaHost,
  driver: tfUi4lBetaDriver,
})
