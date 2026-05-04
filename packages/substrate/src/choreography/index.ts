// Curated re-export of the choreography facade foundation slice.
// choreography-facade — first commit covers branded ids, CurrentWorkContext,
// trigger schema + matcher service, and the public error/suspension types.
// Choreography service, tool bindings, and examples land in later commits.
export { CompletionId, OwnerId, WorkId } from "./branded.js"

export {
  CurrentWorkContext,
  currentWorkContextLayer,
  type CurrentWorkContextValue,
} from "./context.js"

export {
  ChoreographyTrigger,
  MissingTriggerMatcherError,
  ProjectionMatchTrigger,
  TriggerMatchers,
  dispatchTrigger,
  triggerMatchersLayer,
  type TriggerMatchEvaluation,
  type TriggerMatcher,
  type TriggerMatchersService,
} from "./triggers.js"

export {
  ChoreographyTimeout,
  type ChoreographyOperation,
  type ChoreographySuspension,
} from "./errors.js"
