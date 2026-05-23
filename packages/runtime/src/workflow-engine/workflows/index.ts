// Lane 4 runtime-control drain: runtime-control workflow defs moved to
// `subscribers/runtime-control/workflows.ts`. No back-compat re-export from
// this barrel — keeping one would create a workflow-engine ↔
// subscribers/runtime-control folder cycle (subscribers/runtime-control's
// dispatcher imports the engine substrate). Callers import from
// `@firegrid/runtime/subscribers/runtime-control` directly.
// Pure field-equals trigger/evaluator now lives under `transforms/field-equals.ts`
// (Shape C cutover physical target tree). The workflow-engine path is a thin
// re-export shim until callers migrate to `@firegrid/runtime/transforms` (or
// the direct relative path).
export {
  evaluateFieldEquals,
  FieldEqualsPredicateSchema,
  FieldEqualsTriggerSchema,
  type FieldEqualsPredicate,
  type FieldEqualsTrigger,
} from "../../transforms/field-equals.ts"
export {
  WaitForWorkflow,
  WaitForWorkflowLayer,
  WaitForWorkflowMatchOutcomeSchema,
  WaitForWorkflowOutcomeSchema,
  WaitForWorkflowPayloadSchema,
  WaitForWorkflowTimeoutOutcomeSchema,
  waitForWorkflowExecutionId,
  type WaitForWorkflowOutcome,
  type WaitForWorkflowPayload,
} from "./wait-for.ts"
// Body driver retired in the body+kernel deletion wave (stacked on D-B).
// The workflow body Layer + payload, the per-sequence DurableDeferred
// mailbox helpers, and the body's execution-env type alias no longer
// exist; the Shape C per-event handler under `subscribers/runtime-context/`
// owns the runtime loop without a workflow body or per-sequence mailbox.
// Wave 2 (Shape C): the codec-session command sink contract is owned by the
// subscriber target folder. Barrels re-export the session-command names
// from the public subscriber subpath.
export {
  RuntimeContextWorkflowSession,
  type RuntimeContextSessionCommand,
  type RuntimeContextSessionCommandAccepted,
  type RuntimeContextSessionStartedEvidence,
  type RuntimeContextWorkflowSessionService,
} from "../../subscribers/runtime-context-session/index.ts"
export {
  RuntimeContextWorkflowPayload,
  readRuntimeContext,
  runtimeContextWorkflowExecutionId,
  allocateRuntimeActivityAttempt,
  failAfterWritingRunFailed,
  RuntimeExitEvidence,
  StartRuntimeResultSchema,
  writeRunExitedResult,
  writeRunFailedResult,
  writeRunStarted,
  type StartRuntimeResult,
} from "./runtime-context-run.ts"
// Lane 4 runtime-control drain: the Effect-form ingress-row shim moved to
// `transforms/runtime-ingress-transform.ts`. No back-compat re-export from
// this legacy barrel — clean-break directive forbids preserving old runtime
// roots through re-exports. Callers import the file directly (or use the
// pure `agentInputEventFromRuntimeIngressRow` from `@firegrid/runtime/transforms`).
// `ToolCallWorkflow` + `ToolCallWorkflowPayloadSchema` physically moved to
// `subscribers/tool-dispatch/workflow.ts` (post-#727 / tf-up1v cleanup wave).
// Consume via `@firegrid/runtime/subscribers/tool-dispatch` (or the legacy
// alias `@firegrid/runtime/tool-executor` resolving to the same barrel),
// not via `@firegrid/runtime/workflows`.
