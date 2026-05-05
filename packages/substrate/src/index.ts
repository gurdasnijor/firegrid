// firegrid-remediation-hardening.PUBLIC_SURFACES.5
// firegrid-architecture-boundary.SURFACE_AREA.1
//
// Curated substrate root. Raw kernel modules are available only from
// `@durable-agent-substrate/substrate/kernel`.
export {
  EventStream,
  Operation,
  OperationHandle,
  type EventStreamDescriptor,
  type EventStreamDefinition,
  type OperationDefinition,
  type OperationDescriptor,
  type OperationHandleId,
} from "./descriptors/index.ts"

export {
  Projection,
  ProjectionLive,
  ProjectionReadError,
  ProjectionWaitTimeout,
  Work,
  WorkClaim,
  WorkClaimError,
  WorkClaimLive,
  type ClaimAttemptOutcome,
  type Claimed,
  type Performed,
  type ProjectionLiveConfig,
  type ProjectionQuery,
  type ProjectionService,
  type Recorded,
  type WorkClaimLiveConfig,
  type WorkClaimService,
} from "./facade/index.ts"

// choreography-facade — Phase 12 choreography facade (foundation slice).
//
// `ProjectionMatchTrigger` collides with the Phase-7 placeholder interface
// in `./waits.js`. The two have different shapes (the placeholder is the
// loose data field stored on `durable.completion` rows; the choreography
// schema is the typed Effect Schema for runtime/tool input). Keep the
// placeholder as the root `ProjectionMatchTrigger` to avoid silently
// changing root meaning, and re-export the choreography schema under the
// distinct root name `ChoreographyProjectionMatchTrigger`. Subpath consumers
// can still import `ProjectionMatchTrigger` directly from
// `./choreography/index.js`.
export {
  AwakeableToolInput,
  Choreography,
  ChoreographyLive,
  ChoreographyTimeout,
  ChoreographyTools,
  ChoreographyTrigger,
  CompletionId,
  CurrentWorkContext,
  MissingTriggerMatcherError,
  OwnerId,
  ProjectionMatchTrigger as ChoreographyProjectionMatchTrigger,
  ScheduleMeToolInput,
  SleepToolInput,
  TriggerMatchers,
  WaitForToolInput,
  WorkId,
  currentWorkContextLayer,
  dispatchTrigger,
  triggerMatchersLayer,
  type ChoreographyLiveConfig,
  type ChoreographyOperation,
  type ChoreographyService,
  type ChoreographySuspension,
  type ChoreographyToolBinding,
  type ChoreographyToolBindings,
  type ChoreographyToolsConfig,
  type CurrentWorkContextValue,
  type ScheduleAtResult,
  type TriggerMatchEvaluation,
  type TriggerMatcher,
  type TriggerMatchersService,
} from "./choreography/index.ts"
