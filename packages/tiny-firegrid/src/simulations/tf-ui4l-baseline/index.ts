import { defineSimulation } from "../../types.ts"
import { tfUi4lBaselineDriver } from "./driver.ts"
import { tfUi4lBaselineHost } from "./host.ts"

export default defineSimulation({
  id: "tf-ui4l-baseline",
  description:
    "tf-ui4l/INV-6 baseline: today's Activity.make + Stream.runHead shape against a CallerFact stream. Host seeds 3 non-matching + 1 matching fact; driver builds a custom Workflow whose body is Activity.make(execute=Stream.runHead(filtered)) + Activity.make(emit-marker). Establishes the comparison floor for α/β/γ.",
  host: tfUi4lBaselineHost,
  driver: tfUi4lBaselineDriver,
})
