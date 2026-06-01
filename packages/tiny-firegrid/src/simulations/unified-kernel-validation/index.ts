import { defineSimulation } from "../../types.ts"
import { unifiedKernelValidationDriver } from "./driver.ts"
import { unifiedKernelValidationHost } from "./host.ts"

export default defineSimulation({
  id: "unified-kernel-validation",
  description:
    "Validates that a tiny-firegrid simulation host composes the real "
    + "@firegrid/runtime unified FiregridHost factory while the driver "
    + "uses only the public @firegrid/client-sdk surface.",
  host: unifiedKernelValidationHost,
  driver: unifiedKernelValidationDriver,
})
