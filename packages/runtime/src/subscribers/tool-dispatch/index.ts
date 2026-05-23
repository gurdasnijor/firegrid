// subscribers/tool-dispatch/ public surface — Wave B forward-target shim.
//
// SHAPE: D — Activity memoization (see ./README.md).
//
// `RuntimeToolCallWorkflowLayer` is the Shape D tool-dispatch Layer. Its
// implementation currently lives in `agent-event-pipeline/tool-execution/`
// because Wave A did not move the workflow body file. This index.ts is the
// tree-aligned import target so that `composition/host-live.ts` and any
// external consumer reach the Shape D Layer through
// `@firegrid/runtime/subscribers/tool-dispatch` rather than the legacy
// substrate subpath.
//
// Wave 2 physically moves the workflow body under this folder; the public
// subpath stays stable across that move.

export {
  RuntimeToolCallWorkflowLayer,
  ToolCallWorkflow,
} from "../../agent-event-pipeline/tool-execution/runtime-tool-call-workflow.ts"
