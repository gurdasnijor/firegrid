import { defineSimulation } from "../../types.ts"
import { driver } from "./driver.ts"
import { host } from "./host.ts"

export default defineSimulation({
  id: "control-plane-cancel-close",
  description:
    "Probes the current public cancel/close session lifecycle surface and records whether it reaches a kernel terminal consumer.",
  host,
  driver,
})
