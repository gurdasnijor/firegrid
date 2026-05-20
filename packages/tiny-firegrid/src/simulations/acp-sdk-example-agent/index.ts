import { defineSimulation } from "../../types.ts"
import { acpSdkExampleAgentDriver } from "./driver.ts"
import { acpSdkExampleAgentHost } from "./host.ts"

export default defineSimulation({
  id: "acp-sdk-example-agent",
  description:
    "Drives the installed @agentclientprotocol/sdk example ACP agent through Firegrid's public client surface: launch/open/watch, session create/attach/prompt/start/snapshot/wait, permission response, text chunks, tool-call observations, and turn completion.",
  host: acpSdkExampleAgentHost,
  driver: acpSdkExampleAgentDriver,
})
