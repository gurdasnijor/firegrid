import { defineExperiment } from "../../types.ts"
import { adapterStartedAgent, sessionDroveWorkflow } from "../../runner/coverage.ts"
import { driver } from "./driver.ts"
import { host } from "./host.ts"

// cap-4 proof sim (tf-0awo.31.3): CROSS-AGENT DELEGATION over the public surface.
// Re-establishes the deleted inv5-cross-agent-event-choreography shape on the
// unified surface using the session_new agent-tool (#831 / tf-0awo.32): a planner
// agent delegates to a child; the child emits observable output; the child
// RuntimeContext is correlated to the parent. Also the live acceptance that
// #831's session_new lowering works end-to-end.
export default defineExperiment({
  id: "cross-agent-delegation",
  description:
    "Cap-4: a planner delegates to a child via the public session_new agent-tool; the child emits observable output and its RuntimeContext is correlated to the parent (createdBy mcp:<parentContextId>). Driver: @firegrid/client-sdk only; host: real FiregridRuntime.",
  host,
  driver,
  coverage: {
    gates: [
      sessionDroveWorkflow,
      adapterStartedAgent,
      {
        id: "child.session_spawned",
        description: "the planner delegated to a child via session_new (a child session spawned)",
        claim: "spans.exists(s, namedPrefix(s, \"unified.session.spawn/\"))",
      },
      {
        id: "session_new.executed",
        description: "the session_new agent-tool lowering executed on the host",
        claim: "spans.exists(s, namedPrefix(s, \"unified.mcp-tool.execute/\"))",
      },
    ],
  },
})
