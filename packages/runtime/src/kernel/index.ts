export {
  RuntimeHostConfig,
  type RuntimeHostConfigValue,
} from "./runtime-host-config.ts"
export {
  RuntimeContextWorkflowNative,
  RuntimeContextWorkflowNativeLayer,
  RuntimeContextWorkflowPayload,
} from "../workflow-engine/workflows/index.ts"
// Wave 2 (Shape C): the codec-session command sink contract is owned by the
// subscriber target folder. The kernel barrel re-exports it from the
// sanctioned subscriber subpath so host-sdk callers do not have to reach into
// the workflow-engine substrate path.
export {
  RuntimeContextWorkflowSession,
  type RuntimeContextSessionCommand,
  type RuntimeContextSessionCommandAccepted,
  type RuntimeContextSessionStartedEvidence,
  type RuntimeContextWorkflowSessionService,
} from "../subscribers/runtime-context-session/index.ts"
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
