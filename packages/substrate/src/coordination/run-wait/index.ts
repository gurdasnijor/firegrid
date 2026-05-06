// Curated re-export of the run-wait facade foundation slice.
// choreography-facade — first commit covers branded ids, CurrentWorkContext,
// trigger schema + matcher service, and the public error/suspension types.
// RunWait service, tool bindings, and examples land in later commits.
export { CompletionId, OwnerId, WorkId } from "./branded.ts"

export {
  CurrentWorkContext,
  currentWorkContextLayer,
  type CurrentWorkContextValue,
} from "./context.ts"

export {
  RunWaitTrigger,
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
  RunWaitTimeout,
  type RunWaitOperation,
  type RunWaitSuspension,
} from "./errors.ts"

export {
  RunWait,
  RunWaitLive,
  type RunWaitLayerConfig,
  type RunWaitService,
  type RunWaitUntilResult,
} from "./service.ts"

export {
  AwakeableToolInput,
  RunWaitTools,
  ScheduleMeToolInput,
  SleepToolInput,
  WaitForToolInput,
  type RunWaitToolBinding,
  type RunWaitToolBindings,
  type RunWaitToolsConfig,
} from "./tools.ts"
