// Barrel for runtime transforms/ (Shape C cutover semantic path).
//
// Every export here must be a pure function over schemas — no `Effect`, no
// `Layer`, no `Context.Tag`, no I/O.

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
