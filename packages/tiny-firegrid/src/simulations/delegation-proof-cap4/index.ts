import { defineSimulation } from "../../types.ts"
import { delegationProofCap4Driver } from "./driver.ts"
import { delegationProofCap4Host } from "./host.ts"

export default defineSimulation({
  id: "delegation-proof-cap4",
  description:
    "Factory capability #4 proof: a public-client parent session delegates through session_new, resumes the child through session_prompt, and observes delegated child output through public session wait surfaces.",
  host: delegationProofCap4Host,
  driver: delegationProofCap4Driver,
})
