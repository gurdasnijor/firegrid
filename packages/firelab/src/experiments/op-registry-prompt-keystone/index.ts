import { defineExperiment } from "../../types.ts"
import { adapterStartedAgent, sessionDroveWorkflow } from "../../runner/coverage.ts"
import { opRegistryPromptKeystoneDriver } from "./driver.ts"
import { opRegistryPromptKeystoneHost } from "./host.ts"

export default defineExperiment({
  id: "op-registry-prompt-keystone",
  description:
    "Generates the session.prompt channel binding from one annotated Effect Schema record and drives a real ACP prompt through the production per-event runtime path.",
  host: opRegistryPromptKeystoneHost,
  driver: opRegistryPromptKeystoneDriver,
  coverage: {
    gates: [
      sessionDroveWorkflow,
      adapterStartedAgent,
      {
        id: "codec.new_session",
        description: "the real ACP codec opened a session (the generated binding reached the agent)",
        claim: "spans.exists(s, named(s, \"firegrid.codec.sdk.call\"))",
      },
      {
        id: "prompt.produced_output",
        description: "the real ACP prompt produced an agent session update over the generated session.prompt binding",
        claim: "spans.exists(s, named(s, \"firegrid.agent_event_pipeline.acp.session_update\"))",
      },
    ],
  },
})
