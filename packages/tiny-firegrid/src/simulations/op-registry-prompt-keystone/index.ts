import { defineSimulation } from "../../types.ts"
import { opRegistryPromptKeystoneDriver } from "./driver.ts"
import { opRegistryPromptKeystoneHost } from "./host.ts"

export default defineSimulation({
  id: "op-registry-prompt-keystone",
  description:
    "Generates the session.prompt channel binding from one annotated Effect Schema record and drives a real ACP prompt through the production per-event runtime path.",
  host: opRegistryPromptKeystoneHost,
  driver: opRegistryPromptKeystoneDriver,
})
