// firegrid-remediation-hardening.PUBLIC_SURFACES.5
// firegrid-architecture-boundary.SURFACE_AREA.1
//
// Curated substrate root. Raw kernel modules are available only from
// `@firegrid/substrate/kernel`. Server-side coordination (projection,
// work-claim, and RunWait) lives under `./coordination/`.
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
  RunWait,
  CompletionId,
  CurrentWorkContext,
  MissingTriggerMatcherError,
  OwnerId,
  ProjectionMatchTrigger,
  Projection,
  ProjectionLive,
  ProjectionReadError,
  ProjectionWaitTimeout,
  TriggerMatchers,
  Work,
  WorkClaim,
  WorkClaimError,
  WorkClaimLive,
  WorkId,
  currentWorkContextLayer,
  dispatchTrigger,
  triggerMatchersLayer,
  type RunWaitLayerConfig,
  type RunWaitService,
  type RunWaitUntilResult,
  type ClaimAttemptOutcome,
  type Claimed,
  type CurrentWorkContextValue,
  type Performed,
  type ProjectionLiveConfig,
  type ProjectionQuery,
  type ProjectionService,
  type Recorded,
  type TriggerMatchEvaluation,
  type TriggerMatcher,
  type TriggerMatchersService,
  type WorkClaimLiveConfig,
  type WorkClaimService,
} from "./coordination/index.ts"
