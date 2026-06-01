import { defineSimulation } from "../../types.ts"
import { driver } from "./driver.ts"
import { host } from "./host.ts"

export default defineSimulation({
  id: "child-output-existing-channel-router",
  description:
    "Records existing session.agent_output cursor observation semantics as "
    + "trace evidence without adding any parent-child-specific protocol.",
  host,
  driver,
})
