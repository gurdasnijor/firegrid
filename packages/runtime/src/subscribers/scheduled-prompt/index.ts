// subscribers/scheduled-prompt/ public surface — Wave B forward-target shim.
//
// SHAPE: D — DurableClock deadline (see ./README.md).
//
// `ScheduledPromptWorkflowLayer` is the Shape D scheduled-prompt Layer. Its
// implementation currently lives in `workflow-engine/workflows/scheduled-prompt.ts`
// because Wave A did not move the workflow body file. This index.ts is the
// tree-aligned import target so that `composition/host-live.ts` and any
// external consumer reach the Shape D Layer through
// `@firegrid/runtime/subscribers/scheduled-prompt` rather than the legacy
// substrate subpath.
//
// Wave 2 physically moves the workflow body under this folder; the public
// subpath stays stable across that move.

export {
  ScheduledPromptWorkflow,
  ScheduledPromptWorkflowLayer,
} from "../../workflow-engine/workflows/scheduled-prompt.ts"
