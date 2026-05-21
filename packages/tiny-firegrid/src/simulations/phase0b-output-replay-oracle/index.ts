import { defineSimulation } from "../../types.ts"
import { phase0bOracleDriver } from "./driver.ts"
import { phase0bOracleHost } from "./host.ts"

export default defineSimulation({
  id: "phase0b-output-replay-oracle",
  description:
    "Phase 0B de-risk: clean-room oracle for the tf-7kq8 output-replay amplification class. Contrasts the volatile-cursor/live-read specimen (O(resumes x history)) with a durable-cursor primitive (O(distinct outputs)) and gates on the amplification threshold.",
  host: phase0bOracleHost,
  driver: phase0bOracleDriver,
})
