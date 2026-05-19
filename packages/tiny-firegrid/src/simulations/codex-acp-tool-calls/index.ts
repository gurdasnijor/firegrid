import { defineSimulation } from "../../types.ts"
import { codexAcpToolCallDriver } from "./driver.ts"
import { codexAcpHost } from "./host.ts"

export default defineSimulation({
  id: "codex-acp-tool-calls",
  description:
    "Launches the Codex ACP host configuration and drives it through the public Firegrid client surface until the sleep tool-call result is observed or timed out.",
  host: codexAcpHost,
  driver: codexAcpToolCallDriver,
})
