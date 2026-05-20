import { defineSimulation } from "../../types.ts"
import { phase0Wave2BDriver } from "./driver.ts"
import { phase0Wave2BHost } from "./host.ts"

export default defineSimulation({
  id: "phase0-wave-2b-stream-zip-restart-replay",
  description:
    "Phase 0 Wave-2B: exercises a stream-zip runtime-context workflow body across two scoped host generations sharing the same durable workflow/control/output streams.",
  host: phase0Wave2BHost,
  driver: phase0Wave2BDriver,
})
