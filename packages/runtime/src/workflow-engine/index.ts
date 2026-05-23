// `workflow-engine/` is a non-canonical legacy root pending deletion.
// The retired per-sequence durable-deferred input mailbox is gone — runtime
// input arrives as durable `RuntimeControlPlaneTable.inputIntents` rows and
// the Shape C runtime-context subscriber consumes them through
// `tables/runtime-context-input-facts`.
//
// REMAINING SUBSTRATE RESIDUE (per OLA reviewer #726 clarification on
// blocker 3, option b): `DurableStreamsWorkflowEngine` + its engine
// internals are residue here pending a target-tree design amendment.
// No ownership is granted to this root.
//
// RETIREMENT BEAD: tf-z8wq — Target-tree amendment: canonical homes for
// durable workflow engine substrate and remaining kernel leaf surfaces.
// Once tf-z8wq picks the canonical home for the engine substrate, the
// files physically move out of here, this barrel collapses, and the
// composition/ dep-cruiser carve-out shrinks to a deletion.
//
// Wave 1 Shape C move: the runtime-context state store now lives under
// `tables/runtime-context-state.ts`. Public consumers should prefer
// `@firegrid/runtime/tables/runtime-context-state`; this re-export is kept
// for in-tree legacy callers until they retarget.
export {
  makePerContextRuntimeContextStateStore,
  nextOutputObservation,
  type PerContextRuntimeContextStateConfig,
  RuntimeContextStateStore,
  type RuntimeContextStateStoreService,
  RuntimeContextStateTable,
} from "../tables/runtime-context-state.ts"
export {
  DurableStreamsWorkflowEngine,
  make,
  type WorkflowActivityClaimRow,
  type WorkflowActivityRow,
  type WorkflowClockWakeupRow,
  type WorkflowDeferredRow,
  type WorkflowEngineDurableStateOptions,
  WorkflowEngineTable,
  type WorkflowEngineTableService,
  type WorkflowExecutionRow,
} from "./DurableStreamsWorkflowEngine.ts"
