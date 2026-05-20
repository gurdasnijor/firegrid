import { defineSimulation } from "../../types.ts"
import { tfUi4lGammaDriver } from "./driver.ts"
import { tfUi4lGammaHost } from "./host.ts"

export default defineSimulation({
  id: "tf-ui4l-gamma",
  description:
    "tf-ui4l/INV-6 shape γ: Activity.folded sugar with (state, event) => state step and a durable per-step state write (stands in for engine-owned folded state). Termination via takeUntil(state.found). Compare against tf-ui4l-baseline: per-step durability cost.",
  host: tfUi4lGammaHost,
  driver: tfUi4lGammaDriver,
})
