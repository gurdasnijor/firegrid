/**
 * End-to-end auth-path proofs against the in-memory durable-streams double:
 * verify -> resolve -> forward, plus the behavioral misuse-resistance
 * guarantees (cross-tenant, forgery, grant-denial, revocation, expiry).
 *
 * The whole loop runs without a live durable-streams server — the
 * `DurableStreamsForwarder` seam is filled by `makeInMemoryForwarder`.
 */
import {
  HostStreamPrefixWireSchema,
  runtimeContextOutputStreamName,
} from "@firegrid/protocol/launch"
import { sessionContextIdForExternalKey } from "@firegrid/protocol/session-facade"
import { Effect, Exit, Layer, Option, Redacted, Schema } from "effect"
import { beforeEach, describe, expect, it } from "vitest"
import { mintHandle } from "../src/handle.ts"
import { brookhavenTenantGrants, issueToken } from "../src/issue.ts"
import {
  type AuthError,
  EdgeAuthConfigTag,
  EdgeAuthResolver,
  EdgeAuthResolverLive,
  RevocationStore,
  RevocationStoreInMemory,
} from "../src/resolver.ts"
import {
  type EdgeAuthConfig,
} from "../src/resolver.ts"
import {
  type OpaqueHandle,
  TenantIdSchema,
  type TokenClaims,
  TokenClaimsSchema,
} from "../src/schema.ts"
import { makeInMemoryForwarder } from "../src/testkit.ts"

const TOKEN_SECRET = Redacted.make("token-secret-xyz")
const HANDLE_SECRET = Redacted.make("handle-secret-abc")
const PREFIX = Schema.decodeSync(HostStreamPrefixWireSchema)(
  "brookhaven.prod.firegrid.host.h1",
)
const SOURCE = "brookhaven.game"

const config: EdgeAuthConfig = {
  prefix: PREFIX,
  externalKeySource: SOURCE,
  tokenSecret: TOKEN_SECRET,
  handleSecret: HANDLE_SECRET,
}

const claimsOf = (
  tenant: string,
  tokenId: string,
  grants: TokenClaims["grants"],
  exp?: number,
): TokenClaims =>
  Schema.decodeSync(TokenClaimsSchema)({
    iss: "firegrid.test",
    tenant,
    tokenId,
    grants,
    ...(exp === undefined ? {} : { exp }),
  })

const token = (
  tenant: string,
  tokenId: string,
  grants: TokenClaims["grants"] = brookhavenTenantGrants,
  exp?: number,
): string => Effect.runSync(issueToken(TOKEN_SECRET, claimsOf(tenant, tokenId, grants, exp)))

const mint = (tenant: string, contextId: string, handleClass: "intent" | "output"): OpaqueHandle =>
  Effect.runSync(
    mintHandle(HANDLE_SECRET, {
      tenant: Schema.decodeSync(TenantIdSchema)(tenant),
      contextId,
      handleClass,
    }),
  )

const outputStreamFor = (tenant: string, playerId: string): string =>
  runtimeContextOutputStreamName({
    prefix: PREFIX,
    contextId: sessionContextIdForExternalKey({ source: SOURCE, id: `${tenant}:${playerId}` }),
  })

// A fresh forwarder + layer per test (no cross-test state).
let harness: ReturnType<typeof makeHarness>
const makeHarness = () => {
  const forwarder = makeInMemoryForwarder()
  // provideMerge so the test can also reach RevocationStore (to revoke) — a
  // plain provide would consume it and not re-expose it.
  const layer = Layer.provideMerge(
    EdgeAuthResolverLive,
    Layer.mergeAll(
      Layer.succeed(EdgeAuthConfigTag, config),
      RevocationStoreInMemory,
      forwarder.layer,
    ),
  )
  return { forwarder, layer }
}
beforeEach(() => {
  harness = makeHarness()
})

const run = <A, E>(eff: Effect.Effect<A, E, EdgeAuthResolver | RevocationStore>) =>
  Effect.runPromise(Effect.provide(eff, harness.layer))

const runExit = <A, E>(eff: Effect.Effect<A, E, EdgeAuthResolver | RevocationStore>) =>
  Effect.runPromiseExit(Effect.provide(eff, harness.layer))

const expectAuthReason = <A, E>(exit: Exit.Exit<A, E>, reason: AuthError["reason"]) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
    expect((exit.cause.error as AuthError).reason).toBe(reason)
  } else {
    throw new Error(`expected an AuthError(${reason}), got ${JSON.stringify(exit)}`)
  }
}

describe("open (DECIDE-1)", () => {
  it("mints two handles + from-beginning offset for a new session", async () => {
    const result = await run(
      Effect.gen(function*() {
        const resolver = yield* EdgeAuthResolver
        const claims = yield* resolver.verifyToken(token("brookhaven.prod", "tok_1"))
        return yield* resolver.open(claims, { playerId: "player1" })
      }),
    )
    expect(result.intent.length).toBeGreaterThan(0)
    expect(result.output.length).toBeGreaterThan(0)
    expect(result.intent).not.toEqual(result.output)
    expect(result.startOffset).toBe("") // nothing emitted yet
  })

  it("startOffset reflects the output tail for a loaded session", async () => {
    harness.forwarder.seed(outputStreamFor("brookhaven.prod", "player1"), ["e0", "e1"])
    const result = await run(
      Effect.gen(function*() {
        const resolver = yield* EdgeAuthResolver
        const claims = yield* resolver.verifyToken(token("brookhaven.prod", "tok_1"))
        return yield* resolver.open(claims, { playerId: "player1" })
      }),
    )
    expect(result.startOffset).toBe("2")
  })

  it("denies open without an open grant", async () => {
    const exit = await runExit(
      Effect.gen(function*() {
        const resolver = yield* EdgeAuthResolver
        const claims = yield* resolver.verifyToken(
          token("brookhaven.prod", "tok_ro", [{ verb: "read", handleClass: "output" }]),
        )
        return yield* resolver.open(claims, { playerId: "player1" })
      }),
    )
    expectAuthReason(exit, "grant-denied")
  })
})

describe("append + read round-trip", () => {
  it("forwards an intent append to the intent stream and reads output back", async () => {
    const result = await run(
      Effect.gen(function*() {
        const resolver = yield* EdgeAuthResolver
        const claims = yield* resolver.verifyToken(token("brookhaven.prod", "tok_1"))
        const opened = yield* resolver.open(claims, { playerId: "player1" })
        const ack = yield* resolver.append(claims, opened.intent, {
          kind: "prompt",
          playerId: "player1",
          requestId: "r1",
          text: "add a helipad",
        })
        // simulate the agent emitting two output rows after the prompt:
        harness.forwarder.seed(outputStreamFor("brookhaven.prod", "player1"), ["💬 working", "🚀 published"])
        const page = yield* resolver.read(claims, opened.output, Option.none())
        return { ack, page }
      }),
    )
    expect(result.ack.offset).toBe("1")
    expect(result.page.events).toEqual(["💬 working", "🚀 published"])
    expect(result.page.nextOffset).toBe("2")
    // a second read from the persisted cursor sees nothing new (gap-free poll):
    const tail = await run(
      Effect.gen(function*() {
        const resolver = yield* EdgeAuthResolver
        const claims = yield* resolver.verifyToken(token("brookhaven.prod", "tok_1"))
        const opened = yield* resolver.open(claims, { playerId: "player1" })
        return yield* resolver.read(claims, opened.output, Option.some("2"))
      }),
    )
    // re-reading from the persisted cursor "2" (same harness, deterministic
    // handle) returns nothing — the poll parks at the frontier, gap-free.
    expect(tail.events).toEqual([])
  })
})

describe("misuse resistance (behavioral)", () => {
  it("rejects a handle minted for another tenant (tenant-mismatch)", async () => {
    // mint an intent handle bound to game A:
    const ctxA = sessionContextIdForExternalKey({ source: SOURCE, id: "gameA:player1" })
    const handleA = mint("gameA", ctxA, "intent")
    const exit = await runExit(
      Effect.gen(function*() {
        const resolver = yield* EdgeAuthResolver
        // ...used with game B's token:
        const claimsB = yield* resolver.verifyToken(token("gameB", "tok_b"))
        return yield* resolver.append(claimsB, handleA, { kind: "prompt" })
      }),
    )
    expectAuthReason(exit, "tenant-mismatch")
  })

  it("rejects a tampered handle (bad-handle / forged signature)", async () => {
    const ctx = sessionContextIdForExternalKey({ source: SOURCE, id: "brookhaven.prod:p" })
    const handle = mint("brookhaven.prod", ctx, "intent")
    const tampered = (handle.slice(0, -2) + (handle.endsWith("a") ? "b" : "a")) as OpaqueHandle
    const exit = await runExit(
      Effect.gen(function*() {
        const resolver = yield* EdgeAuthResolver
        const claims = yield* resolver.verifyToken(token("brookhaven.prod", "tok_1"))
        return yield* resolver.append(claims, tampered, { kind: "prompt" })
      }),
    )
    expectAuthReason(exit, "bad-handle")
  })

  it("rejects a tampered token (bad-token)", async () => {
    const good = token("brookhaven.prod", "tok_1")
    const tampered = good.slice(0, -2) + (good.endsWith("a") ? "b" : "a")
    const exit = await runExit(
      Effect.gen(function*() {
        const resolver = yield* EdgeAuthResolver
        return yield* resolver.verifyToken(tampered)
      }),
    )
    expectAuthReason(exit, "bad-token")
  })

  it("denies append for a read-only token (grant-denied)", async () => {
    const ctx = sessionContextIdForExternalKey({ source: SOURCE, id: "brookhaven.prod:p" })
    const intentHandle = mint("brookhaven.prod", ctx, "intent")
    const exit = await runExit(
      Effect.gen(function*() {
        const resolver = yield* EdgeAuthResolver
        const claims = yield* resolver.verifyToken(
          token("brookhaven.prod", "tok_ro", [{ verb: "read", handleClass: "output" }]),
        )
        return yield* resolver.append(claims, intentHandle, { kind: "prompt" })
      }),
    )
    expectAuthReason(exit, "grant-denied")
  })

  it("an output handle cannot be appended to (grant-denied — no append:output grant exists)", async () => {
    const ctx = sessionContextIdForExternalKey({ source: SOURCE, id: "brookhaven.prod:p" })
    const outputHandle = mint("brookhaven.prod", ctx, "output")
    const exit = await runExit(
      Effect.gen(function*() {
        const resolver = yield* EdgeAuthResolver
        const claims = yield* resolver.verifyToken(token("brookhaven.prod", "tok_1"))
        return yield* resolver.append(claims, outputHandle, { kind: "prompt" })
      }),
    )
    expectAuthReason(exit, "grant-denied")
  })
})

describe("revocation + expiry (DECIDE-4)", () => {
  it("revoked token is rejected (denylist)", async () => {
    const exit = await runExit(
      Effect.gen(function*() {
        const resolver = yield* EdgeAuthResolver
        const revocation = yield* RevocationStore
        // verifies fine before revocation:
        yield* resolver.verifyToken(token("brookhaven.prod", "tok_revoke"))
        yield* revocation.revoke("tok_revoke")
        return yield* resolver.verifyToken(token("brookhaven.prod", "tok_revoke"))
      }),
    )
    expectAuthReason(exit, "revoked")
  })

  it("expired token is rejected", async () => {
    const exit = await runExit(
      Effect.gen(function*() {
        const resolver = yield* EdgeAuthResolver
        return yield* resolver.verifyToken(
          token("brookhaven.prod", "tok_exp", brookhavenTenantGrants, 1),
        )
      }),
    )
    expectAuthReason(exit, "expired")
  })

  it("a far-future exp still verifies", async () => {
    const claims = await run(
      Effect.gen(function*() {
        const resolver = yield* EdgeAuthResolver
        return yield* resolver.verifyToken(
          token("brookhaven.prod", "tok_ok", brookhavenTenantGrants, 9_999_999_999),
        )
      }),
    )
    expect(claims.tenant).toBe("brookhaven.prod")
  })
})
