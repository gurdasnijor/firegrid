import { defineSimulation } from "../../types.ts"
import { runtimeContextSessionWorkflowDriver } from "./driver.ts"
import { runtimeContextSessionWorkflowHost } from "./host.ts"

export default defineSimulation({
  id: "runtime-context-session-workflow",
  description:
    "RCSW Shape D proof — per-(contextId, activityAttempt) Workflow.make + "
    + "Activity-memoized spawn + cursor-based input loop + kernel-owned write+arm "
    + "controller, gating the production RuntimeContextSessionWorkflow lane that "
    + "replaces the Shape C subscriber's lifecycle gap (input-before-runs.started "
    + "dropped silently + startOrAttach TOCTOU spawning two ACP processes, surfaced "
    + "by Zed agent_silent / firegrid run --prompt --agent claude-acp). Three "
    + "probes: A early-input-then-start, B concurrent-execute-no-dual-spawn, "
    + "C post-start-input-in-order. Real DurableStreamsWorkflowEngine; no new "
    + "runner/queue/substrate.",
  host: runtimeContextSessionWorkflowHost,
  driver: runtimeContextSessionWorkflowDriver,
})
