import { defineSimulation } from "../../types.ts"
import { codexAcpToolCallDriver } from "./driver.ts"
import { codexAcpHost } from "./host.ts"

export default defineSimulation({
  id: "codex-acp-tool-calls",
  description:
    "Runs real Codex ACP over the durable-streams MCP ingress (session_new "
    + "child of the gateway runtime) against the unified host-owned "
    + "runtime-context MCP server, recording whether codex calls the Firegrid "
    + "`sleep` tool and emits the marker.",
  host: codexAcpHost,
  driver: codexAcpToolCallDriver,
})
