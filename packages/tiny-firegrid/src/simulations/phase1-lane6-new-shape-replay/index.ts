import { defineSimulation } from "../../types.ts"
import { phase1Lane6NewShapeReplayDriver } from "./driver.ts"
import { phase1Lane6NewShapeReplayHost } from "./host.ts"

export default defineSimulation({
  id: "phase1-lane6-new-shape-replay",
  description:
    "Phase-1 Lane 6: scoped-bounce replay smoke for the exact INV-2 WaitForWorkflow shape, Activity(Stream.runHead) + DurableDeferred.raceAll + DurableClock.sleep.",
  host: phase1Lane6NewShapeReplayHost,
  driver: phase1Lane6NewShapeReplayDriver,
})
