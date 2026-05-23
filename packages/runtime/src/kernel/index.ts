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
// subpath so host-sdk composition imports them here rather than from a
// substrate-internal subpath (forbidden across the host-sdk boundary).
// The implementation now lives under `tables/runtime-context-state.ts` per
// the Shape C runtime physical target tree (Wave 1 cutover); host-sdk
// callers should migrate to `@firegrid/runtime/tables/runtime-context-state`
// — this kernel re-export is the existing legacy entry kept until those
// callers retarget.
export {
  makePerContextRuntimeContextStateStore,
  nextOutputObservation,
  type PerContextRuntimeContextStateConfig,
  RuntimeContextStateStore,
  type RuntimeContextStateStoreService,
} from "../tables/runtime-context-state.ts"
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
  // Wave D-A (PR #714): `RuntimeInputIntentDispatcherLive` re-export
  // dropped. The host-scoped dispatcher fiber that delivered durable
  // input intents into the legacy body's per-sequence mailbox has no
  // production reader after the Shape C subscriber cutover. The Live
  // symbol still exists in `runtime-context-workflow-runtime.ts` (PARK)
  // because the workflow body's `runtime-input-deferred.ts` mailbox is
  // still exercised by tests + tiny-firegrid sims that cover the legacy
  // body path; both die with D-E body retirement.
  type RuntimeContextWorkflowCheckpointHandle,
} from "./runtime-context-workflow-runtime.ts"
