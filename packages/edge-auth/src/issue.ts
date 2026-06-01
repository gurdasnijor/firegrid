/**
 * Token issuance (the trusted side of DECIDE-4). An operator mints one
 * long-lived capability token per tenant and pastes it into the game's
 * dashboard-managed Secret. Revocation is out-of-band via {@link
 * RevocationStore} (denylist the `tokenId`); rotation is "issue a new token,
 * denylist the old one."
 */
import { type Effect, type Redacted } from "effect"
import { type TokenClaims, TokenClaimsSchema } from "./schema.ts"
import { type EnvelopeError, signEnvelope } from "./sign.ts"

const sign = signEnvelope(TokenClaimsSchema)

export const issueToken = (
  tokenSecret: Redacted.Redacted<string>,
  claims: TokenClaims,
): Effect.Effect<string, EnvelopeError> => sign(tokenSecret, claims)

/**
 * The canonical Brookhaven tenant grant set (consumer-contract §6): open +
 * append-intent + read-output, nothing else. Provided as a helper so callers
 * never hand-assemble a grant array (and so a future grant addition is made
 * in one place).
 */
export const brookhavenTenantGrants = [
  { verb: "open" },
  { verb: "append", handleClass: "intent" },
  { verb: "read", handleClass: "output" },
] as const satisfies TokenClaims["grants"]
