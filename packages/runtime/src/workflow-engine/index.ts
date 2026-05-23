// `workflow-engine/` is a non-canonical legacy root. The retired
// per-sequence durable-deferred input mailbox is gone (runtime input arrives
// as durable `RuntimeControlPlaneTable.inputIntents` rows; the Shape C
// runtime-context subscriber consumes them through
// `tables/runtime-context-input-facts`). The substrate (engine + internals)
// moved to `../engine/` under bead tf-z8wq per the target-tree amendment in
// `docs/architecture/2026-05-22-runtime-physical-target-tree.md` §"Target
// Tree" (engine/ leaf-tier substrate).
//
// This barrel stays as the `@firegrid/runtime/workflow-engine` public
// subpath while host-sdk + tiny-firegrid + runtime tests still consume the
// substrate by that name. Re-exports point at the new home; the legacy
// subpath retires when those external callers retarget to
// `@firegrid/runtime/composition/host-workflow-engine` (which exposes the
// composed `HostWorkflowEngineLive` Layer rather than the bare substrate
// factory).
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
} from "../engine/durable-streams-workflow-engine.ts"
