import { defineSimulation } from "../../types.ts"
import { tf7kq8OutputReplayStormDriver } from "./driver.ts"
import { tf7kq8OutputReplayStormHost } from "./host.ts"

export default defineSimulation({
  id: "tf-7kq8-output-replay-storm",
  description:
    "tf-7kq8: a deterministic stdio-jsonl agent emits many output chunks in one turn, exercising the production runtime-context workflow output-observation path across many workflow resumes. Surfaces (and, with the memo fix, eliminates) the agent_output.initial re-read amplification that hangs live ACP turns.",
  host: tf7kq8OutputReplayStormHost,
  driver: tf7kq8OutputReplayStormDriver,
})
