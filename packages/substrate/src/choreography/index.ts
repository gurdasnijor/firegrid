// Curated re-export of the choreography facade foundation slice.
// choreography-facade — first commit covers branded ids, CurrentWorkContext,
// trigger schema + matcher service, and the public error/suspension types.
// Choreography service, tool bindings, and examples land in later commits.
export { CompletionId, OwnerId, WorkId } from "./branded.ts"

export {
  CurrentWorkContext,
  currentWorkContextLayer,
  type CurrentWorkContextValue,
} from "./context.ts"

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
} from "./triggers.ts"

export {
  ChoreographyTimeout,
  type ChoreographyOperation,
  type ChoreographySuspension,
} from "./errors.ts"

export {
  Choreography,
  ChoreographyLive,
  type ChoreographyLiveConfig,
  type ChoreographyService,
  type ScheduleAtResult,
} from "./service.ts"

export {
  AwakeableToolInput,
  ChoreographyTools,
  ScheduleMeToolInput,
  SleepToolInput,
  WaitForToolInput,
  type ChoreographyToolBinding,
  type ChoreographyToolBindings,
  type ChoreographyToolsConfig,
} from "./tools.ts"
