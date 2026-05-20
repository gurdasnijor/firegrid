import { defineSimulation } from "../../types.ts"
import { inv3RestartReplayDriver } from "./driver.ts"
import { inv3RestartReplayHost } from "./host.ts"

export default defineSimulation({
  id: "inv3-restart-replay",
  description:
    "Exercises a minimal WaitForWorkflow across two scoped host generations, proving replay from already-written match rows, live re-subscription after restart, and DurableClock timeout deadline preservation.",
  host: inv3RestartReplayHost,
  driver: inv3RestartReplayDriver,
})
