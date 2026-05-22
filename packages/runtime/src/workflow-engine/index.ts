// sidecar/shape-c-input-facts: appendRuntimeInputDeferred / runtime-input-deferred.ts
// retired. Shape C consumes RuntimeContextInputFacts directly (see
// agent-event-pipeline/authorities/runtime-context-input-facts.ts).
export {
  makePerContextRuntimeContextStateStore,
  nextOutputObservation,
  type PerContextRuntimeContextStateConfig,
  RuntimeContextStateStore,
  type RuntimeContextStateStoreService,
  RuntimeContextStateTable,
} from "./runtime-context-state.ts"
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
