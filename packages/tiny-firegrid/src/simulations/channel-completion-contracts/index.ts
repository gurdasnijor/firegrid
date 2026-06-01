import { defineSimulation } from "../../types.ts"
import { driver } from "./driver.ts"
import { host } from "./host.ts"

export default defineSimulation({
  id: "channel-completion-contracts",
  description:
    "Records the channel completion contract shape as trace evidence: "
    + "route metadata is the inspectable completion source and terminal "
    + "operation receipts are the transport projection evidence.",
  host,
  driver,
})
