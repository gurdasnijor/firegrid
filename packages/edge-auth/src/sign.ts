/**
 * Signed-envelope codec — the cryptographic core under both the capability
 * token and the opaque handles.
 *
 * Wire form: `base64url(payloadJson) "." base64url(HMAC-SHA256(secret, payloadB64))`.
 * The payload is a Schema-encoded value, so token/handle claim shapes stay
 * single-sourced in `schema.ts`. Verification recomputes the MAC and compares
 * in constant time, then decodes the payload through the same Schema.
 *
 * Why this shape (solution-map C-4 (c), "capability-bearing signed handle"):
 *  - STATELESS validation — no shared handle-store to run or keep durable.
 *  - OPAQUE by construction — the client cannot read claims, forge a handle,
 *    enumerate, or derive a sibling context/class handle without the secret.
 *  - Revocation is at the *token* layer (a `tokenId` denylist, DECIDE-4),
 *    not per-handle — bulk-revoking a session is one denylist entry.
 *
 * `node:crypto` is used directly (HMAC is not a library surface to rebuild);
 * the secret is held as `Redacted` so it never lands in logs or errors.
 */
import { createHmac, timingSafeEqual } from "node:crypto"
import { Data, Effect, Redacted, Schema } from "effect"

export class EnvelopeError extends Data.TaggedError("edge-auth/EnvelopeError")<{
  readonly reason: "malformed" | "bad-signature" | "schema"
  readonly detail?: string
}> {}

// `~` is RFC-3986-unreserved (safe unencoded in an HTTP path segment) and is
// NOT in the base64url alphabet ([A-Za-z0-9_-]) — so it cleanly separates the
// two base64url fields AND lets an opaque handle ride a `:handle` path param
// without the router treating a `.` as an extension boundary.
const ENVELOPE_SEPARATOR = "~"

const toB64Url = (buf: Buffer): string => buf.toString("base64url")

const macOf = (secret: Redacted.Redacted<string>, payloadB64: string): Buffer =>
  createHmac("sha256", Redacted.value(secret)).update(payloadB64).digest()

/**
 * Sign a Schema-typed value into an opaque envelope string.
 */
export const signEnvelope = <A, I>(schema: Schema.Schema<A, I>) => {
  const encode = Schema.encode(schema)
  return (
    secret: Redacted.Redacted<string>,
    value: A,
  ): Effect.Effect<string, EnvelopeError> =>
    encode(value).pipe(
      Effect.mapError(
        (cause) => new EnvelopeError({ reason: "schema", detail: String(cause) }),
      ),
      Effect.map((encoded) => {
        const payloadB64 = toB64Url(Buffer.from(JSON.stringify(encoded), "utf8"))
        const sigB64 = toB64Url(macOf(secret, payloadB64))
        return `${payloadB64}${ENVELOPE_SEPARATOR}${sigB64}`
      }),
    )
}

/**
 * Verify + decode an envelope string back to its Schema-typed value. Fails
 * `bad-signature` for any tamper/forgery, `malformed` for shape problems,
 * `schema` if the (authentic) payload no longer satisfies the Schema.
 */
export const verifyEnvelope = <A, I>(schema: Schema.Schema<A, I>) => {
  const decode = Schema.decodeUnknown(schema)
  return (
    secret: Redacted.Redacted<string>,
    wire: string,
  ): Effect.Effect<A, EnvelopeError> =>
    Effect.gen(function*() {
      const dot = wire.indexOf(ENVELOPE_SEPARATOR)
      if (dot <= 0 || dot === wire.length - 1) {
        return yield* Effect.fail(new EnvelopeError({ reason: "malformed" }))
      }
      const payloadB64 = wire.slice(0, dot)
      const sigB64 = wire.slice(dot + ENVELOPE_SEPARATOR.length)

      const presented = Buffer.from(sigB64, "utf8")
      const expected = Buffer.from(toB64Url(macOf(secret, payloadB64)), "utf8")
      // Length guard first: `timingSafeEqual` throws on unequal lengths.
      if (
        presented.length !== expected.length ||
        !timingSafeEqual(presented, expected)
      ) {
        return yield* Effect.fail(new EnvelopeError({ reason: "bad-signature" }))
      }

      const parsed: unknown = yield* Effect.try({
        try: (): unknown =>
          JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")),
        catch: () => new EnvelopeError({ reason: "malformed" }),
      })
      return yield* decode(parsed).pipe(
        Effect.mapError(
          (cause) => new EnvelopeError({ reason: "schema", detail: String(cause) }),
        ),
      )
    })
}
