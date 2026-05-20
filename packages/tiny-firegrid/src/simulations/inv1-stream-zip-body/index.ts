import { defineSimulation } from "../../types.ts"
import { inv1StreamZipBodyDriver } from "./driver.ts"
import { inv1StreamZipBodyHost } from "./host.ts"

export default defineSimulation({
  id: "inv1-stream-zip-body",
  description:
    "Swaps the runtime-context workflow body for Stream.zipLatest(input, output).runForEach and drives two claude-agent-acp prompt round-trips through the public session surface.",
  host: inv1StreamZipBodyHost,
  driver: inv1StreamZipBodyDriver,
})
