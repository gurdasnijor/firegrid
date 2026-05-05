// Curated re-export of the Phase 10 ergonomic facade.
// effect-native-api.EFFECT_SERVICES.7 — public capabilities are services
// or service-backed functions whose dependencies stay in the Effect R
// channel. ergonomic-facade.API_BOUNDARY.2 — kernel modules are NOT the
// primary public API; consumers should import from this facade.
export {
  Projection,
  ProjectionLive,
  ProjectionReadError,
  ProjectionWaitTimeout,
  type ProjectionLiveConfig,
  type ProjectionQuery,
  type ProjectionService,
} from "./projection.ts"

export {
  Work,
  WorkClaim,
  WorkClaimError,
  WorkClaimLive,
  type ClaimAttemptOutcome,
  type Claimed,
  type Performed,
  type Recorded,
  type WorkClaimLiveConfig,
  type WorkClaimService,
} from "./work.ts"
