import { defineSimulation } from "../../types.ts"
import { phase0Wave2APermissionStreamDriver } from "./driver.ts"
import { phase0Wave2APermissionStreamHost } from "./host.ts"

export default defineSimulation({
  id: "phase0-wave-2a-permission-stream",
  description:
    "Phase 0 Wave-2A probe: drives a permission response through the INV-1 Stream.zipLatest runtime-context body and records the permission-stream verdict.",
  host: phase0Wave2APermissionStreamHost,
  driver: phase0Wave2APermissionStreamDriver,
})
