import { defineSimulation } from "../../types.ts"
import { tfUi4lAlphaDriver } from "./driver.ts"
import { tfUi4lAlphaHost } from "./host.ts"

export default defineSimulation({
  id: "tf-ui4l-alpha",
  description:
    "tf-ui4l/INV-6 shape α: Activity.streamed sugar over Activity.make. Body consumes the CallerFact stream itself; sugar layer durably writes an emit-cursor per row into a side DurableTable (stands in for engine-owned cursor). Compare against tf-ui4l-baseline: workflow body LOC, emit-cursor span density, restart-replay seed model.",
  host: tfUi4lAlphaHost,
  driver: tfUi4lAlphaDriver,
})
