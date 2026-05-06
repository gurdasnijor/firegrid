// firegrid-architecture-boundary.SURFACE_AREA.1
// firegrid-remediation-hardening.PUBLIC_SURFACES.5
// ergonomic-facade.API_BOUNDARY.2
//
// Server-side coordination surface for the Firegrid substrate.
//
// This folder unifies the previously split `facade/` (projection +
// work-claim) and `choreography/` (durable workflow primitives) into
// a single responsibility-named home. Runtime authors and other
// server-side participants compose the substrate's read snapshots,
// claim authority, and durable choreography from this surface; raw
// kernel modules stay behind the explicit `@firegrid/substrate/kernel`
// subpath.

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

export * from "./choreography/index.ts"
