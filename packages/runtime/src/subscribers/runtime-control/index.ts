// Public subpath: `@firegrid/runtime/subscribers/runtime-control`.
//
// Shape D justification (per `./README.md`): cross-execution handoff. A
// host-control request is claimed by a workflow that exclusively owns the
// target RuntimeContext's lifecycle; claim/dispatch/result correlation
// across host restart requires the durable execution boundary that
// `@effect/workflow` machinery provides.
//
// Lane 4 runtime-control drain moved the prior `control-plane/` files
// into this folder:
//   workflow-engine/workflows/runtime-control-request.ts → ./workflows.ts
//   control-plane/control-request-dispatcher.ts          → ./dispatcher.ts
//   control-plane/lifecycle-evidence.ts                  → ./lifecycle-evidence.ts
//
// The runtime-session move wave (#734) added the side-effects Layer:
//   host-sdk/src/host/control-request-side-effects.ts    → ./control-request-side-effects.ts
//
// Authority Tags (RuntimeContextInsert, RuntimeContextRead, RuntimeRuns,
// RuntimeRunAppendAndGet, RuntimeLocalContextResolver,
// RuntimeControlPlaneRecorderLive) are not re-exported here — they live in
// `@firegrid/runtime/authorities` and consumers import them from there.

export {
  RuntimeContextProvisionWorkflow,
  RuntimeContextProvisionWorkflowPayload,
  RuntimeControlRequestClaimedOutcomeSchema,
  RuntimeControlRequestDispatchOutcomeSchema,
  RuntimeControlRequestDoneOutcomeSchema,
  RuntimeLifecycleWorkflow,
  RuntimeLifecycleWorkflowPayload,
  RuntimeStartWorkflow,
  RuntimeStartWorkflowPayload,
  runtimeControlRequestWorkflowExecutionId,
  runtimeControlRequestWorkflowStreamUrl,
  type RuntimeControlRequestDispatchOutcome,
} from "./workflows.ts"

export {
  reconcileRuntimeControlRequestsOnce,
  RuntimeControlRequestControlPlaneLive,
  RuntimeControlRequestReconciler,
  RuntimeControlRequestReconcilerLive,
  runtimeControlRequestReconcilerDefaults,
  RuntimeControlRequestSideEffects,
  runRuntimeControlRequestReconciler,
  type RuntimeControlRequestControlPlaneOptions,
  type RuntimeControlRequestReconcilerOptions,
  type RuntimeControlRequestReconcilerService,
  type RuntimeControlRequestSideEffectsService,
  type RuntimeControlRequestStartResult,
} from "./dispatcher.ts"

export {
  activeActivityAttempt,
  recordLifecycleTerminalEvidence,
} from "./lifecycle-evidence.ts"

export { RuntimeControlRequestSideEffectsLive } from "./control-request-side-effects.ts"
