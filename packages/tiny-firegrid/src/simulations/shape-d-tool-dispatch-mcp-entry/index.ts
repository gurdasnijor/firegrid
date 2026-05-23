// Shape D MCP-entry tool-dispatch shape validation sim.
//
// Validates the D-Tool YELLOW plan: can the current Shape D
// `ToolCallWorkflow` + `RuntimeToolUseExecutor` path replace the
// host-sdk `workflowRuntime.run` bridge without a new
// `tables/runtime-tool-result.ts` primitive and without #684 salvage?
//
// Verdict + paired deletions + falsifiers in `FINDING.md`. Probe at
// `packages/tiny-firegrid/test/shape-d-tool-dispatch-mcp-entry/probe.test.ts`.

export * from "./resources.ts"
export * from "./runtime-layer.ts"
export * from "./host-facade.ts"
