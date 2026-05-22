export {
  RuntimeHostConfig,
  type RuntimeHostConfigValue,
} from "./runtime-host-config.ts"
export {
  RuntimeContextWorkflowNative,
  RuntimeContextWorkflowNativeLayer,
  RuntimeContextWorkflowPayload,
  RuntimeContextWorkflowSession,
  type RuntimeContextSessionCommand,
  type RuntimeContextSessionCommandAccepted,
  type RuntimeContextSessionStartedEvidence,
  type RuntimeContextWorkflowSessionService,
} from "../workflow-engine/workflows/index.ts"
// tf-aseo: the workflow-owned durable loop-state store is host-composed
// per-context wiring. Surface its host-facing pieces (capability tag + the
// per-context Layer factory) through the sanctioned `@firegrid/runtime/kernel`
// subpath so host-sdk composition imports them here rather than from the
// workflow-engine substrate subpath (forbidden across the host-sdk boundary).
// The implementation lives beside the workflow body that consumes the tag
// directly (workflow-engine/runtime-context-state.ts).
export {
  makePerContextRuntimeContextStateStore,
  nextOutputObservation,
  type PerContextRuntimeContextStateConfig,
  RuntimeContextStateStore,
  type RuntimeContextStateStoreService,
} from "../workflow-engine/runtime-context-state.ts"
export {
  executeRuntimeContextWorkflow,
} from "./internal/run-context-workflow.ts"
export {
  readRuntimeContext,
  requireLocalRuntimeContextWithHostSession,
  runtimeContextWorkflowExecutionId,
  runtimeExecutionClock,
} from "./runtime-context-helpers.ts"
export {
  RuntimeContextCheckpointSource,
  RuntimeContextInput,
  RuntimeContextWorkflowRuntime,
  RuntimeContextWorkflowRuntimeLive,
  RuntimeInputIntentDispatcherLive,
  type RuntimeContextWorkflowCheckpointHandle,
} from "./runtime-context-workflow-runtime.ts"
