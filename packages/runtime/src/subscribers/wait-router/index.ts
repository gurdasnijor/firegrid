// subscribers/wait-router/ public surface — Wave B forward-target shim.
//
// SHAPE: D — durable wait/timeout (see ./README.md).
//
// `WaitForWorkflowLayer` is the Shape D wait-router Layer. Its implementation
// currently lives in `workflow-engine/workflows/wait-for.ts` because Wave A
// did not move the workflow body file. This index.ts is the tree-aligned
// import target so that `composition/host-live.ts` and any external consumer
// reach the Shape D Layer through `@firegrid/runtime/subscribers/wait-router`
// rather than the legacy substrate subpath.
//
// Wave 2 physically moves the workflow body under this folder; the public
// subpath stays stable across that move.

export {
  WaitForWorkflow,
  WaitForWorkflowLayer,
} from "../../workflow-engine/workflows/wait-for.ts"
