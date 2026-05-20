import { defineSimulation } from "../../types.ts"
import { waitPreAttachDriver } from "./driver.ts"
import { waitPreAttachHost } from "./host.ts"

export default defineSimulation({
  id: "wait-pre-attach-roundtrip",
  description:
    "Host pre-seeds one CallerFact at startup; drives claude-agent-acp to issue a single wait_for that should match the pre-attached fact. Surfaces §6 tool-search behavior (does the agent issue a tool *call*, not just *list*?), pre-attach delivery semantics (does the wait router scan existing rows?), and produces a fully-instrumented trace with codec-attr + subprocess-wire data for the §6 diagnostic.",
  host: waitPreAttachHost,
  driver: waitPreAttachDriver,
})
