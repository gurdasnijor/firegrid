/**
 * Opaque handle mint/open — a signed envelope of {@link HandleClaims}.
 *
 * The minted string is what the edge sees: opaque, unforgeable, carrying no
 * readable stream name. `openHandle` is the inverse, used server-side by the
 * resolver to recover `{tenant, contextId, handleClass}` before mapping to a
 * concrete durable-streams URL.
 */
import { type Effect, type Redacted } from "effect"
import { type HandleClaims, HandleClaimsSchema, type OpaqueHandle } from "./schema.ts"
import { type EnvelopeError, signEnvelope, verifyEnvelope } from "./sign.ts"

const sign = signEnvelope(HandleClaimsSchema)
const verify = verifyEnvelope(HandleClaimsSchema)

export const mintHandle = (
  secret: Redacted.Redacted<string>,
  claims: HandleClaims,
): Effect.Effect<OpaqueHandle, EnvelopeError> =>
  sign(secret, claims) as Effect.Effect<OpaqueHandle, EnvelopeError>

export const openHandle = (
  secret: Redacted.Redacted<string>,
  handle: OpaqueHandle,
): Effect.Effect<HandleClaims, EnvelopeError> => verify(secret, handle)
