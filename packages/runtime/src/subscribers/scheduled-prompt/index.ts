// subscribers/scheduled-prompt/ public surface — forward-target shim.
//
// SHAPE: D — DurableClock deadline (see ./README.md).
//
// `ScheduledPromptWorkflowLayer` is the Shape D scheduled-prompt Layer. Its
// implementation still lives in `workflow-engine/workflows/scheduled-prompt.ts`
// because moving the body into this folder requires reshaping its
// producer-side dependency — the body imports
// `producers/ingress-writers/scheduled-prompt-append.ts`, which the dep-cruise
// rule `runtime-subscribers-no-producers-import` (HARD STOP) forbids from any
// subscribers/ file. See `docs/architecture/2026-05-23-tf-6hqx-scheduled-prompt-move-blocker.md` for the report (typed-source
// reshape or producer relocation required before the physical move).
//
// This index.ts is the tree-aligned import target so that
// `composition/host-live.ts` and any external consumer reach the Shape D
// Layer through `@firegrid/runtime/subscribers/scheduled-prompt` rather than
// the legacy substrate subpath. The public subpath stays stable across the
// future physical move.

export {
  ScheduledPromptWorkflow,
  ScheduledPromptWorkflowLayer,
} from "../../workflow-engine/workflows/scheduled-prompt.ts"
