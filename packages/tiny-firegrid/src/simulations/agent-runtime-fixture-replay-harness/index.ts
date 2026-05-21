import { defineSimulation } from "../../types.ts"
import { agentRuntimeFixtureReplayDriver } from "./driver.ts"
import { agentRuntimeFixtureReplayHost } from "./host.ts"

export default defineSimulation<unknown, unknown>({
  id: "agent-runtime-fixture-replay-harness",
  description:
    "Spec-first replay and fuzz harness for agent-runtime source/codec conformance fixtures, with live-agent canaries declared but env-gated.",
  host: agentRuntimeFixtureReplayHost,
  driver: agentRuntimeFixtureReplayDriver,
})
