// Wave D-A Shape (b) — proof barrel.
//
// See FINDING.md for the verdict ribbon (validation hypothesis, falsification
// target, test matrix, retirement targets).

export {
  appendInput,
  appendOutput,
  inputFactsForContext,
  initialRuntimeContextEventState,
  loadState,
  makeSubstrate,
  outputsForContext,
  saveState,
  type RuntimeAgentOutputObservation,
  type RuntimeContextEventState,
  type RuntimeContextTargetEvent,
  type RuntimeIngressInputRow,
  type Substrate,
} from "./resources.ts"

export {
  identityKeyedHandler,
  identityKeyedTransition,
  makeLegacyStateRef,
  sequenceKeyedHandler,
  sequenceKeyedTransition,
  type Action,
} from "./handler.ts"

export {
  mergedKeyedSource,
  mergedKeyedSourceMulti,
  runShapeBSubscriber,
  runShapeBSubscriberMulti,
} from "./subscriber.ts"
