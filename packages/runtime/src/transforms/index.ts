// Barrel for runtime transforms/ (Shape C cutover semantic path).
//
// Every export here must be a pure function over schemas — no `Effect`, no
// `Layer`, no `Context.Tag`, no I/O. The Effect-form adapter
// `runtime-ingress-transform.ts` lives in this folder (the amendment moved
// it from `workflow-engine/workflows/`) but is intentionally NOT re-exported
// from this barrel so the "no `Effect` in transforms/index.ts" rule holds;
// callers that need the Effect-typed signature import the file directly.

export {
  FieldEqualsPredicateSchema,
  FieldEqualsTriggerSchema,
  evaluateFieldEquals,
  type FieldEqualsPredicate,
  type FieldEqualsTrigger,
} from "./field-equals.ts"
export {
  RuntimeContextTransitionActionSchema,
  RuntimeContextTransitionResultSchema,
  transitionInputEvent,
  transitionOutputEvent,
  type RuntimeContextTransitionAction,
  type RuntimeContextTransitionResult,
} from "./runtime-context-transition.ts"
export {
  RuntimeIngressAgentInputTransformError,
  agentInputEventFromRuntimeIngressRow,
} from "./decode-ingress-row.ts"
export {
  runtimeAgentOutputObservationFromRow,
} from "./decode-output-row.ts"
