export {
  appendRuntimeInputDeferred,
} from "./runtime-input-deferred.ts"
// Wave 1 Shape C move: the runtime-context state store now lives under
// `tables/runtime-context-state.ts`. Public consumers should prefer
// `@firegrid/runtime/tables/runtime-context-state`; this re-export is kept
// for in-tree legacy callers still on `@firegrid/runtime/workflow-engine`
// (host-sdk test suite) until they retarget.
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
