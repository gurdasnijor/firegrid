import { defineSimulation } from "../../types.ts"
import { unifiedKernelValidationDriver } from "./driver.ts"
import { unifiedKernelValidationHost } from "./host.ts"

export default defineSimulation({
  id: "unified-kernel-validation",
  description:
    "Validates that a firelab simulation host composes the real "
    + "@firegrid/runtime unified FiregridHost factory while the driver "
    + "uses only the public @firegrid/client-sdk surface.",
  host: unifiedKernelValidationHost,
  driver: unifiedKernelValidationDriver,
  // The computed verdict. These gates are the CEL form of the gating
  // host-substrate assertions that previously lived as a hardcoded imperative
  // trace gate — each names a span the production runtime emits server-side that
  // the public-surface driver cannot forge.
  coverage: {
    gates: [
      {
        id: "workflow_engine.execute",
        description: "the workflow engine executed a session workflow body",
        claim: "spans.exists(s, named(s, \"firegrid.workflow_engine.execution.execute\"))",
      },
      {
        id: "adapter.start_or_attach",
        description: "the production codec adapter started or attached the agent",
        claim: "spans.exists(s, named(s, \"firegrid.unified.adapter.start_or_attach\"))",
      },
      {
        id: "local_process.open_byte_pipe",
        description: "LocalProcessSandboxProvider spawned a real subprocess",
        claim: "spans.exists(s, named(s, \"firegrid.agent_event_pipeline.source.local_process.open_byte_pipe\"))",
      },
      {
        id: "adapter.deregister",
        description: "the session terminal signal drove adapter deregistration",
        claim: "spans.exists(s, named(s, \"firegrid.unified.adapter.deregister\"))",
      },
      {
        // Parity refinement: seam-coverage paired terminal_signal with deregister
        // by contextId + startTime ordering. Strict temporal ordering needs a
        // relational helper the CEL vocab does not yet expose; both spans firing
        // host-side is the forge-proof core. Ordering is a documented follow-up.
        id: "session.terminal_signal",
        description: "a session terminal signal was recorded",
        claim: "spans.exists(s, named(s, \"firegrid.unified.session.terminal_signal\"))",
      },
      {
        // Parity with seam-coverage assertion 6 (acp.tool_use_observed): a real
        // provider-executed ACP ToolUse reached the journal path. Liveness +
        // forge-proof (the `agent-tools`-side update cannot be driver-forged).
        id: "acp.tool_use_observed",
        description: "a real ACP ToolUse session update reached the journal path",
        claim:
          "spans.exists(s, named(s, \"firegrid.agent_event_pipeline.acp.session_update\") && attr(s, \"firegrid.agent_output.tag\") == \"ToolUse\")",
      },
      {
        // Liveness-ANCHORED safety gate: a real adapter.send happened AND none
        // failed the codec send. The leading exists keeps the .all non-vacuous
        // (the seam-coverage *_absent assertion passed trivially on an empty set).
        id: "tool_result.codec_send_failure_absent",
        description:
          "CODEC_RUNTIME.4 — adapter.send ran and none failed the ToolResult codec send",
        claim:
          "spans.exists(s, named(s, \"firegrid.unified.adapter.send\")) && spans.filter(s, named(s, \"firegrid.unified.adapter.send\")).all(t, statusMessage(t) != \"codec send failed\")",
      },
    ],
    corroborations: [
      {
        id: "acp.session_update.observed",
        description: "real ACP session updates reached the journal path",
        claim: "spans.exists(s, named(s, \"firegrid.agent_event_pipeline.acp.session_update\"))",
      },
      {
        // Safety property with NO liveness anchor in this sim: provider-executed
        // ACP ToolUse must NOT relay a rejected ToolResult, and indeed zero
        // tool_result spans fire here. Kept as a report-only regression sentinel
        // — if a tool_result ever appears with the rejection message, it surfaces
        // here. It cannot be a forge-proof GATE (a gate needs a span that fired).
        id: "acp.tool_result_rejection_absent",
        description:
          "CODEC_RUNTIME.5 — no ACP ToolResult rejection relayed (no tool_result spans by design)",
        claim:
          "spans.filter(s, named(s, \"firegrid.agent_event_pipeline.acp.tool_result\")).all(t, statusMessage(t) != \"ACP ToolResult input is out-of-band for this codec slice\")",
      },
    ],
  },
})
