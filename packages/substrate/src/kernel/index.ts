// firegrid-remediation-hardening.PUBLIC_SURFACES.2
// firegrid-remediation-hardening.PUBLIC_SURFACES.5
//
// Explicit kernel subpath for substrate internals. Public application-facing
// roots should not import from here; runtime internals, compatibility adapters,
// and tests that need raw durable authority APIs may.

export * from "../descriptors/index.ts"
export * from "../schema/index.ts"
export * from "../projection.ts"
export * from "../stream.ts"
export * from "../state-machine.ts"
export * from "../producer.ts"
export * from "../projection/ready-work.ts"
export * from "../operator.ts"
export * from "../operator-errors.ts"
export * from "../retained-records.ts"
export * from "../waits.ts"
export * from "../subscribers.ts"
export * from "../facade/index.ts"
export * from "../event-plane/index.ts"
export {
  attemptClaim,
  type AttemptClaimArgs,
} from "../internal-claim.ts"
