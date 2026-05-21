import { defineSimulation } from "../../types.ts"
import { acpEdgeTransportDriver } from "./driver.ts"
import { acpEdgeTransportHost } from "./host.ts"

export default defineSimulation({
  id: "acp-edge-transport",
  description:
    "Host-topology ACP stdio edge proof: an in-memory ACP client talks to Firegrid-as-agent, Firegrid maps prompt turns through public session channel verbs, and completion follows TurnComplete while the session stays alive.",
  host: acpEdgeTransportHost,
  driver: acpEdgeTransportDriver,
})
