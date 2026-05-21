import { defineSimulation } from "../../../types.ts"
import { sim3BindingSwapIsolationDriver } from "./driver.ts"
import { sim3BindingSwapIsolationHost } from "./host.ts"

export default defineSimulation({
  id: "sim3-binding-swap-isolation",
  description:
    "Cycle 1 Sim 3: scoped SessionPermissionChannel binding swap preserves durable permission response rows without cross-session leak.",
  host: sim3BindingSwapIsolationHost,
  driver: sim3BindingSwapIsolationDriver,
})
