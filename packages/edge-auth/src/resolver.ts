/**
 * `EdgeAuthResolver` — the authorization brain of the thin token -> handle
 * layer (tf-r06u.33). It does four things and nothing else:
 *
 *   verifyToken — Bearer -> verified {@link TokenClaims} (+ exp + denylist)
 *   open        — mint the {intent, output} handle pair + startOffset (D1)
 *   append      — authorize (handle, "append") then forward bytes
 *   read        — authorize (handle, "read") then forward a catch-up page
 *
 * It NEVER interprets the intent/output payloads (that is the host
 * intent-observer's job, tf-r06u.42) and NEVER hands a stream name or DS
 * credential to the caller — it resolves an opaque handle to a stream name
 * server-side and forwards through {@link DurableStreamsForwarder}. That makes
 * it an authorizing reverse-proxy, not a gateway (solution-map §C-1 (a)).
 */
import {
  type HostStreamPrefix,
  runtimeContextIntentStreamName,
  runtimeContextOutputStreamName,
} from "@firegrid/protocol/launch"
import { sessionContextIdForExternalKey } from "@firegrid/protocol/session-facade"
import { Clock, Context, Data, Effect, Layer, Option, type Redacted } from "effect"
import {
  DurableStreamsForwarder,
  type ForwardAppendResult,
  type ForwardError,
  type ForwardGone,
  type ForwardProducer,
  type ForwardReadResult,
} from "./forwarder.ts"
import { mintHandle, openHandle } from "./handle.ts"
import {
  type Grant,
  type HandleClass,
  type OpaqueHandle,
  type OpenRequest,
  type OpenResult,
  type TokenClaims,
  TokenClaimsSchema,
  type Verb,
} from "./schema.ts"
import { verifyEnvelope } from "./sign.ts"

const verifyTokenEnvelope = verifyEnvelope(TokenClaimsSchema)

/**
 * The single closed failure surface of the auth layer. Every `reason` is a
 * deliberate denial; none carries a stream name, claim payload, or secret —
 * the edge learns *that* it was denied, never *what* it could not reach.
 */
export class AuthError extends Data.TaggedError("edge-auth/AuthError")<{
  readonly reason:
    | "bad-token"
    | "expired"
    | "revoked"
    | "bad-handle"
    | "tenant-mismatch"
    | "grant-denied"
}> {}

/**
 * Revocation denylist (DECIDE-4: long-lived + revocable on demand). The
 * resolver only reads it; an operator surface (rotation/denylist) writes it.
 * The in-memory `Live` is fine for a single host; a durable-backed store is a
 * follow-up that implements this same tag.
 */
export class RevocationStore extends Context.Tag("edge-auth/RevocationStore")<
  RevocationStore,
  {
    readonly isRevoked: (tokenId: string) => Effect.Effect<boolean>
    readonly revoke: (tokenId: string) => Effect.Effect<void>
  }
>() {}

export const RevocationStoreInMemory = Layer.sync(RevocationStore, () => {
  const revoked = new Set<string>()
  return RevocationStore.of({
    isRevoked: (tokenId) => Effect.sync(() => revoked.has(tokenId)),
    revoke: (tokenId) => Effect.sync(() => void revoked.add(tokenId)),
  })
})

/**
 * Static configuration of one resolver instance. `prefix` MUST match the host
 * it fronts (built via `makeHostStreamPrefix({namespace, hostId})`), so the
 * derived stream names agree with what the host reads/writes. Two distinct
 * secrets (token vs handle) is defense-in-depth: forging a handle and forging
 * a token require different keys.
 */
export interface EdgeAuthConfig {
  readonly prefix: HostStreamPrefix
  /** `externalKey.source` for derived sessions (consumer-contract §3.1). */
  readonly externalKeySource: string
  readonly tokenSecret: Redacted.Redacted<string>
  readonly handleSecret: Redacted.Redacted<string>
}

export class EdgeAuthConfigTag extends Context.Tag("edge-auth/EdgeAuthConfig")<
  EdgeAuthConfigTag,
  EdgeAuthConfig
>() {}

export class EdgeAuthResolver extends Context.Tag("edge-auth/EdgeAuthResolver")<
  EdgeAuthResolver,
  {
    readonly verifyToken: (
      bearer: string,
    ) => Effect.Effect<TokenClaims, AuthError>
    readonly open: (
      claims: TokenClaims,
      request: OpenRequest,
    ) => Effect.Effect<OpenResult, AuthError | ForwardError>
    readonly append: (
      claims: TokenClaims,
      handle: OpaqueHandle,
      body: unknown,
      producer?: ForwardProducer,
    ) => Effect.Effect<ForwardAppendResult, AuthError | ForwardError>
    readonly read: (
      claims: TokenClaims,
      handle: OpaqueHandle,
      offset: Option.Option<string>,
    ) => Effect.Effect<ForwardReadResult, AuthError | ForwardError | ForwardGone>
  }
>() {}

const grantsAllow = (
  grants: ReadonlyArray<Grant>,
  verb: Verb,
  handleClass?: HandleClass,
): boolean =>
  grants.some((g) =>
    handleClass === undefined
      ? g.verb === verb
      : g.verb === verb && "handleClass" in g && g.handleClass === handleClass,
  )

export const EdgeAuthResolverLive = Layer.effect(
  EdgeAuthResolver,
  Effect.gen(function*() {
    const config = yield* EdgeAuthConfigTag
    const revocation = yield* RevocationStore
    const forwarder = yield* DurableStreamsForwarder

    const streamNameFor = (
      contextId: string,
      handleClass: HandleClass,
    ): string =>
      handleClass === "intent"
        ? runtimeContextIntentStreamName({ prefix: config.prefix, contextId })
        : runtimeContextOutputStreamName({ prefix: config.prefix, contextId })

    /** Verify a handle and resolve it to a stream name, enforcing tenant
     * ownership + the token's closed grant set for `verb`. */
    const resolveHandle = (
      claims: TokenClaims,
      handle: OpaqueHandle,
      verb: Verb,
    ): Effect.Effect<{ readonly streamName: string; readonly handleClass: HandleClass }, AuthError> =>
      Effect.gen(function*() {
        const handleClaims = yield* openHandle(config.handleSecret, handle).pipe(
          Effect.mapError(() => new AuthError({ reason: "bad-handle" })),
        )
        // A handle minted for game Y is unusable with game X's token.
        if (handleClaims.tenant !== claims.tenant) {
          return yield* Effect.fail(new AuthError({ reason: "tenant-mismatch" }))
        }
        if (!grantsAllow(claims.grants, verb, handleClaims.handleClass)) {
          return yield* Effect.fail(new AuthError({ reason: "grant-denied" }))
        }
        return {
          streamName: streamNameFor(handleClaims.contextId, handleClaims.handleClass),
          handleClass: handleClaims.handleClass,
        }
      })

    const verifyToken = (bearer: string): Effect.Effect<TokenClaims, AuthError> =>
      Effect.gen(function*() {
        const claims = yield* verifyTokenEnvelope(config.tokenSecret, bearer).pipe(
          Effect.mapError(() => new AuthError({ reason: "bad-token" })),
        )
        if (claims.exp !== undefined) {
          const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000)
          if (nowSeconds >= claims.exp) {
            return yield* Effect.fail(new AuthError({ reason: "expired" }))
          }
        }
        if (yield* revocation.isRevoked(claims.tokenId)) {
          return yield* Effect.fail(new AuthError({ reason: "revoked" }))
        }
        return claims
      })

    const open = (
      claims: TokenClaims,
      request: OpenRequest,
    ): Effect.Effect<OpenResult, AuthError | ForwardError> =>
      Effect.gen(function*() {
        if (!grantsAllow(claims.grants, "open")) {
          return yield* Effect.fail(new AuthError({ reason: "grant-denied" }))
        }
        // Session identity is DETERMINISTIC (createOrLoad is idempotent by the
        // same hash), so `open` derives the contextId without creating the
        // session — the host creates it lazily when the first prompt intent is
        // bridged (tf-r06u.42). tenant comes from the token, never the request.
        const contextId = sessionContextIdForExternalKey({
          source: config.externalKeySource,
          id: `${claims.tenant}:${request.playerId}`,
        })
        const intent = yield* mintHandle(config.handleSecret, {
          tenant: claims.tenant,
          contextId,
          handleClass: "intent",
        }).pipe(Effect.mapError(() => new AuthError({ reason: "bad-handle" })))
        const output = yield* mintHandle(config.handleSecret, {
          tenant: claims.tenant,
          contextId,
          handleClass: "output",
        }).pipe(Effect.mapError(() => new AuthError({ reason: "bad-handle" })))

        // startOffset = current output tail, or "" (read-from-beginning) for a
        // not-yet-created session. The edge polls GET output?offset=startOffset.
        const outputStream = streamNameFor(contextId, "output")
        const head = yield* forwarder.head(outputStream).pipe(
          // A head failure must not strand `open`; fall back to from-beginning.
          Effect.orElseSucceed(() => Option.none<string>()),
        )
        return {
          intent,
          output,
          startOffset: Option.getOrElse(head, () => ""),
        }
      })

    const append = (
      claims: TokenClaims,
      handle: OpaqueHandle,
      body: unknown,
      producer?: ForwardProducer,
    ): Effect.Effect<ForwardAppendResult, AuthError | ForwardError> =>
      resolveHandle(claims, handle, "append").pipe(
        Effect.flatMap(({ streamName }) =>
          forwarder.append(streamName, body, producer),
        ),
      )

    const read = (
      claims: TokenClaims,
      handle: OpaqueHandle,
      offset: Option.Option<string>,
    ): Effect.Effect<ForwardReadResult, AuthError | ForwardError | ForwardGone> =>
      resolveHandle(claims, handle, "read").pipe(
        Effect.flatMap(({ streamName }) => forwarder.read(streamName, offset)),
      )

    return EdgeAuthResolver.of({ verifyToken, open, append, read })
  }),
)
