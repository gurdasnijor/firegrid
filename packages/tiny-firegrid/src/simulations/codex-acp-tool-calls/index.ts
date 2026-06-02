import { defineSimulation } from "../../types.ts"
import { codexAcpToolCallDriver } from "./driver.ts"
import { codexAcpHost } from "./host.ts"

export default defineSimulation({
  id: "codex-acp-tool-calls",
  description:
    "Runs real Codex ACP through the public Firegrid client surface against "
    + "the unified host-owned MCP server, recording both the runtimeContextMcp "
    + "marker gap and the explicit mcpServers positive path.",
  host: codexAcpHost,
  driver: codexAcpToolCallDriver,
})
