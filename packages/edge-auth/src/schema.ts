/**
 * Edge-auth capability model — Brookhaven G1 (tf-r06u.33).
 *
 * Spec: `docs/analysis/2026-06-01-brookhaven-roblox-solution-map.md` §C-4
 * (recommended (a) thin auth-proxy + (c) signed-handle encoding) and
 * `docs/analysis/2026-06-01-brookhaven-consumer-contract.md` §6/§9
 * (DECIDE-1 `open` verb, DECIDE-4 long-lived+revocable, DECIDE-5
 * tenant-scope, opaque handles, no sibling enumeration / derivation).
 *
 * durable-streams puts auth/authz explicitly out of scope (PROTOCOL §12.1),
 * so this is a THIN token -> opaque-handle authorizing layer IN FRONT of the
 * existing durable-streams read/append surface — not a gateway. The substrate
 * stays the single read-authority; this module only decides *who may address
 * which opaque handle with which verb*, then forwards.
 *
 * Misuse-resistance (tf-r06u.27 §9): illegal states are unrepresentable. The
 * grant union below cannot express an admin/wildcard grant, cannot express
 * "append to output" or "read intent", and verbs/classes are closed literal
 * sets. The edge surface is `(opaqueHandle, verb)` from closed sets — it
 * NARROWS the `(string, unknown)` channel-facade hole, never widens it.
 */
import { Schema } from "effect"

/**
 * The tenant a token is scoped to — one game (e.g. `"brookhaven.prod"`).
 * DECIDE-5: tenant-scope only; there are no per-player tokens. The kid
 * allowlist is enforced in the Roblox server before it ever appends.
 */
export const TenantIdSchema = Schema.NonEmptyString.pipe(
  Schema.brand("edge-auth/TenantId"),
)
export type TenantId = Schema.Schema.Type<typeof TenantIdSchema>

/**
 * The closed verb set. There is deliberately NO `delete` / `close` / `admin`
 * / wildcard verb — those cannot be named, so a token cannot grant them.
 */
export const VerbSchema = Schema.Literal("open", "append", "read")
export type Verb = Schema.Schema.Type<typeof VerbSchema>

/**
 * The two — and only two — opaque handle classes a session exposes
 * (consumer-contract §2: "please make it exactly two"). `intent` is
 * append-only (prompts + permission responses); `output` is read-only (the
 * whole typed agent-output observation stream).
 */
export const HandleClassSchema = Schema.Literal("intent", "output")
export type HandleClass = Schema.Schema.Type<typeof HandleClassSchema>

/**
 * A single grant. Modeled as a discriminated union so the *only*
 * representable grants are exactly the three the contract names:
 *   - `open`            (class-less — mints the handle pair)
 *   - `append` + intent (append-only on the intent stream)
 *   - `read`   + output (read-only on the output projection)
 *
 * "append to output" and "read intent" are STRUCTURALLY unrepresentable: the
 * append arm pins `handleClass: "intent"`, the read arm pins `"output"`. A
 * grant carrying the wrong pairing fails to decode.
 */
// Each arm is strict (`onExcessProperty: "error"`) so the shapes are EXACT:
// `{verb:"open"}` with a stray `handleClass` is rejected, not silently
// widened — "open is class-less" is then a real structural guarantee, not a
// convention.
const STRICT = { parseOptions: { onExcessProperty: "error" } } as const

export const GrantSchema = Schema.Union(
  Schema.Struct({ verb: Schema.Literal("open") }).annotations(STRICT),
  Schema.Struct({
    verb: Schema.Literal("append"),
    handleClass: Schema.Literal("intent"),
  }).annotations(STRICT),
  Schema.Struct({
    verb: Schema.Literal("read"),
    handleClass: Schema.Literal("output"),
  }).annotations(STRICT),
).annotations({
  identifier: "edge-auth/Grant",
  description:
    "A closed (verb, handleClass) capability. No admin/wildcard grant is representable.",
})
export type Grant = Schema.Schema.Type<typeof GrantSchema>

/**
 * The claims carried by a capability token (the single Bearer the edge holds,
 * from `HttpService:GetSecret`). Signed + verified by {@link sign}.
 *
 * DECIDE-4: `exp` is OPTIONAL — omitting it yields a long-lived token (the
 * token lives in a dashboard-managed Secret, so short-exp fights rotation).
 * Revocation is by `tokenId` denylist, on demand.
 */
export const TokenClaimsSchema = Schema.Struct({
  iss: Schema.NonEmptyString,
  tenant: TenantIdSchema,
  /** Stable id used as the revocation (denylist) key — the token's `sub`. */
  tokenId: Schema.NonEmptyString,
  grants: Schema.NonEmptyArray(GrantSchema),
  /** Epoch seconds. Absent => long-lived (DECIDE-4). */
  exp: Schema.optional(Schema.Number),
}).annotations({ identifier: "edge-auth/TokenClaims" })
export type TokenClaims = Schema.Schema.Type<typeof TokenClaimsSchema>

/**
 * The claims sealed inside an opaque handle. The handle's wire form is a
 * signed envelope of exactly this — so the client cannot read it, forge it,
 * enumerate siblings, or derive another context/class handle (DECIDE-5 /
 * solution-map C-4 (c)). The host maps `{tenant, contextId, handleClass}` to
 * a concrete durable-streams stream URL server-side; that mapping never
 * crosses to the edge.
 */
export const HandleClaimsSchema = Schema.Struct({
  tenant: TenantIdSchema,
  contextId: Schema.NonEmptyString,
  handleClass: HandleClassSchema,
}).annotations({ identifier: "edge-auth/HandleClaims" })
export type HandleClaims = Schema.Schema.Type<typeof HandleClaimsSchema>

/**
 * An opaque capability handle as it appears on the edge surface: a signed
 * string that reveals nothing about the underlying stream. Branded so it is
 * never confused with a raw stream name anywhere in the type system.
 */
export const OpaqueHandleSchema = Schema.NonEmptyString.pipe(
  Schema.brand("edge-auth/OpaqueHandle"),
)
export type OpaqueHandle = Schema.Schema.Type<typeof OpaqueHandleSchema>

/**
 * The body of an `open` call. The tenant is taken from the verified token,
 * never the request — so the edge cannot open a session in another game.
 * `requestId` is optional here (it is the prompt idempotency key the edge
 * carries forward into its first intent append, not needed to derive the
 * session identity).
 */
export const OpenRequestSchema = Schema.Struct({
  playerId: Schema.NonEmptyString,
  requestId: Schema.optional(Schema.NonEmptyString),
}).annotations({
  identifier: "edge-auth/OpenRequest",
  parseOptions: { onExcessProperty: "error" },
})
export type OpenRequest = Schema.Schema.Type<typeof OpenRequestSchema>

/**
 * The result of `open` (DECIDE-1 (b)): the two opaque handles + the output
 * stream offset the edge should begin polling from. `startOffset` is the
 * output projection's current tail at open time (or the read-from-beginning
 * sentinel for a not-yet-created session) — the edge passes it straight to
 * `GET {output}?offset=` and persists `Stream-Next-Offset` thereafter.
 */
export const OpenResultSchema = Schema.Struct({
  intent: OpaqueHandleSchema,
  output: OpaqueHandleSchema,
  startOffset: Schema.String,
}).annotations({ identifier: "edge-auth/OpenResult" })
export type OpenResult = Schema.Schema.Type<typeof OpenResultSchema>
