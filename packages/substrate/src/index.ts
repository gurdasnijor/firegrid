// firegrid-remediation-hardening.PUBLIC_SURFACES.5
// firegrid-architecture-boundary.SURFACE_AREA.1
//
// Curated substrate root. Raw kernel modules are available only from
// `@firegrid/substrate/kernel`.
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
// firegrid-remediation-hardening.STATIC_QUALITY.1
// The typed choreography `ProjectionMatchTrigger` is the canonical root
// export; the older placeholder stays behind kernel/internal subpaths.
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
  ProjectionMatchTrigger,
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
