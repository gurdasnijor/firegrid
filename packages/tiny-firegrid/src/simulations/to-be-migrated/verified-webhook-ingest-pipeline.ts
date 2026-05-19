/* eslint-disable */
import {
  Firegrid,
  type FiregridSessionHandle,
  local,
} from "@firegrid/client-sdk/firegrid"
import {
  FiregridRuntimeHostLive,
  type FiregridHost,
} from "@firegrid/host-sdk"
import type { TinyFiregridSimulation, TinyFiregridSimulationEnv } from "../../types.ts"
import { Effect, type Layer } from "effect"

// SUBSTRATE-PROPERTY simulation — factory-vision §7.1 attempt + §8 evidence.
//
// It ATTEMPTS to express "external event -> durable verified fact" the way a
// real product consumer would wire it through the PUBLIC Firegrid client/host
// surface ONLY. It does NOT import src/configurations/, does NOT import or
// migrate the runtime-owned @firegrid/runtime verified-webhook-ingest adapter,
// and does NOT redesign ownership. The product owns route/secret/status; the
// question under test is what the public Firegrid surface can express.
//
// Per factory-vision §8, the reach-past attempt is the evidence either way:
//   - clean public-surface expression  => capability proven;
//   - forced reach-past / inexpressible => a precise gap finding.
//
// The verified-webhook capability decomposes into four sub-capabilities. This
// sim drives each through the public surface and records, as falsifiable
// booleans in the trace artifact, which are expressible without reaching past:
//
//  1. hmacVerifyOnPublicSurface — does the PUBLIC Firegrid surface verify the
//     HMAC? (Product computes/verifies HMAC itself here; this records whether
//     Firegrid's public surface owns any of it.)
//  2. deterministicSourceKey — is a deterministic [source, externalEventKey]
//     handle expressible publicly? (sessions.createOrLoad externalKey.)
//  3. idempotentInsertOrGet — same key twice => one durable fact handle.
//  4. conflictRejection — same key + different payload hash => rejection.
//  5. factObservableViaPublicWait — is the verified fact observable to a
//     public wait_for? (Only agent-output/permission waits exist publicly.)

interface VerifiedWebhookIngestResult {
  readonly hmacVerifyOnPublicSurface: boolean
  readonly productHmacVerified: boolean
  readonly deterministicSourceKey: boolean
  readonly idempotentInsertOrGet: boolean
  readonly conflictRejection: boolean
  readonly factObservableViaPublicWait: boolean
  readonly publicSurfaceExpressible: boolean
  readonly evidence: ReadonlyArray<string>
}

// A trivial deterministic no-op runtime. A verified-fact ingest runs no agent;
// createOrLoad still requires a runtime intent (itself part of the gap: there
// is no fact-only public append). We never call start(), so nothing spawns —
// createOrLoad just writes/loads the durable context row keyed by externalKey.
const noopRuntime = (variantTag: string) =>
  local.jsonl({
    argv: [
      globalThis.process.execPath,
      "-e",
      `void ${JSON.stringify(variantTag)};process.exit(0)`,
    ],
    agentProtocol: "stdio-jsonl",
    cwd: globalThis.process.cwd(),
  })

// Product-owned HMAC verification (WebCrypto, no node import; deterministic).
// This is product code, NOT a Firegrid public capability — recorded as such.
const productHmacSign = (
  secret: string,
  body: string,
): Effect.Effect<string, unknown> =>
  Effect.tryPromise(async () => {
    const enc = new TextEncoder()
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    )
    const sig = await globalThis.crypto.subtle.sign("HMAC", key, enc.encode(body))
    return [...new Uint8Array(sig)]
      .map(b => b.toString(16).padStart(2, "0"))
      .join("")
  })

const payloadHash = (body: string): Effect.Effect<string, unknown> =>
  Effect.tryPromise(async () => {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(body),
    )
    return [...new Uint8Array(digest)]
      .map(b => b.toString(16).padStart(2, "0"))
      .join("")
  })

const verifiedWebhookIngestDriver = (
  env: TinyFiregridSimulationEnv,
): Effect.Effect<VerifiedWebhookIngestResult, unknown, Firegrid> =>
  Effect.gen(function*() {
    const evidence: Array<string> = []
    const firegrid = yield* Firegrid

    // ---- Sub-capability 1: HMAC verify (product-owned; not public Firegrid).
    const secret = "product-held-webhook-secret"
    const source = "tiny-firegrid-webhook"
    const externalEventKey = `evt-${env.runId}`
    const rawBodyA = JSON.stringify({ event: "order.created", id: externalEventKey, n: 1 })
    const rawBodyB = JSON.stringify({ event: "order.created", id: externalEventKey, n: 2 })

    const sigA = yield* productHmacSign(secret, rawBodyA)
    const recomputed = yield* productHmacSign(secret, rawBodyA)
    const tampered = yield* productHmacSign(secret, `${rawBodyA}tampered`)
    const productHmacVerified = sigA === recomputed && sigA !== tampered
    // The PUBLIC Firegrid client/host surface exposes no HMAC verify symbol;
    // the product had to do this entirely in its own code.
    const hmacVerifyOnPublicSurface = false
    evidence.push(
      `hmac: verified by product code only (productHmacVerified=${productHmacVerified}); ` +
      "no HMAC/verify symbol on @firegrid/client-sdk or @firegrid/host-sdk.",
    )

    // ---- Sub-capability 2+3: deterministic [source,key] + idempotent get.
    // The closest public primitive is sessions.createOrLoad, whose contextId
    // is derived deterministically from [externalKey.source, externalKey.id].
    const hashA = yield* payloadHash(rawBodyA)
    const first = yield* firegrid.sessions.createOrLoad({
      externalKey: { source, id: externalEventKey },
      runtime: noopRuntime(`hashA:${hashA}`),
      createdBy: "tiny-firegrid-webhook-product",
    })
    const second = yield* firegrid.sessions.createOrLoad({
      externalKey: { source, id: externalEventKey },
      runtime: noopRuntime(`hashA:${hashA}`),
      createdBy: "tiny-firegrid-webhook-product",
    })
    const deterministicSourceKey =
      typeof first.contextId === "string" && first.contextId.length > 0
    const idempotentInsertOrGet = first.contextId === second.contextId
    evidence.push(
      "idempotent [source,key]: createOrLoad twice (same key, same payload) -> " +
      `contextId stable=${idempotentInsertOrGet} (${first.contextId}); ` +
      "the durable handle is a runtime CONTEXT keyed by [source,id], not a " +
      "verified fact with a payload binding.",
    )

    // ---- Sub-capability 4: conflict rejection on same key + different hash.
    // Re-ingest the SAME externalKey with a DIFFERENT payload (different HMAC
    // and different body hash). A verified-fact substrate must reject this.
    const sigB = yield* productHmacSign(secret, rawBodyB)
    const hashB = yield* payloadHash(rawBodyB)
    let conflictRejected = false
    const conflicting = yield* firegrid.sessions.createOrLoad({
      externalKey: { source, id: externalEventKey },
      runtime: noopRuntime(`hashB:${hashB}:${sigB.slice(0, 8)}`),
      createdBy: "tiny-firegrid-webhook-product",
    }).pipe(
      Effect.map(handle => ({ ok: true as const, handle })),
      Effect.catchAll(error => {
        conflictRejected = true
        return Effect.succeed({ ok: false as const, error })
      }),
    )
    // The public surface keys ONLY on [source,id]; the payload is not part of
    // the key and there is no payload-hash conflict check. A differing-payload
    // re-ingest is silently aliased to the same contextId, NOT rejected.
    const silentlyAliased =
      conflicting.ok && conflicting.handle.contextId === first.contextId
    const conflictRejection = conflictRejected
    evidence.push(
      "conflict rejection: same key + different payload hash " +
      `(hashA=${hashA.slice(0, 8)} vs hashB=${hashB.slice(0, 8)}) -> ` +
      `rejected=${conflictRejection}, silentlyAliasedToSameContext=${silentlyAliased}. ` +
      "public createOrLoad does NOT bind payload to key; no conflict primitive.",
    )

    // ---- Sub-capability 5: fact observable to a public wait_for.
    // The only public waits are agent-output / permission-request waits, which
    // require a running agent producing output. A pure verified-fact ingest
    // has no agent output. Attempt the closest public wait honestly.
    const factObservableViaPublicWait = yield* observeFactViaPublicWait(first)
    evidence.push(
      `fact observable via public wait: ${factObservableViaPublicWait}. ` +
      "only wait.forAgentOutput/forPermissionRequest exist publicly; neither " +
      "is a wait over a verified product fact (no agent output for an ingest).",
    )

    const publicSurfaceExpressible =
      hmacVerifyOnPublicSurface &&
      deterministicSourceKey &&
      idempotentInsertOrGet &&
      conflictRejection &&
      factObservableViaPublicWait

    return {
      hmacVerifyOnPublicSurface,
      productHmacVerified,
      deterministicSourceKey,
      idempotentInsertOrGet,
      conflictRejection,
      factObservableViaPublicWait,
      publicSurfaceExpressible,
      evidence,
    }
  })

// Honest attempt to observe the "fact" through the only public wait surface.
// Returns false when (as expected) no agent-output observation matches,
// because a verified-fact ingest produces no agent output.
const observeFactViaPublicWait = (
  session: FiregridSessionHandle,
): Effect.Effect<boolean, unknown> =>
  session.wait.forAgentOutput({ timeoutMs: 5_000 }).pipe(
    Effect.map(result => result.matched),
    Effect.catchAll(() => Effect.succeed(false)),
  )

const inlineVerifiedWebhookHost = (
  env: TinyFiregridSimulationEnv,
): Layer.Layer<FiregridHost, unknown> => {
  const hostId = "host-a"
  // TFIND-005: production host factories still return a layer whose public
  // surface is `FiregridHost` but whose inferred output channel is `any`.
   
  return FiregridRuntimeHostLive({
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
    hostId,
    hostSessionId: `${hostId}-session`,
    input: true,
    ...(env.localProcessEnv === undefined
      ? {}
      : { localProcessEnv: env.localProcessEnv }),
  })
}

export const verifiedWebhookIngestSimulation = {
  id: "verified-webhook-ingest-pipeline",
  description:
    "Attempts to express external-event -> durable verified fact through the PUBLIC Firegrid client/host surface as a real consumer would (no runtime-adapter, no src/configurations). Records which of HMAC-verify / deterministic [source,key] / idempotent insert-or-get / conflict-rejection / fact-observable-wait are expressible publicly — the factory-vision §8 gap evidence.",
  makeHost: inlineVerifiedWebhookHost,
  driver: verifiedWebhookIngestDriver,
} satisfies TinyFiregridSimulation<VerifiedWebhookIngestResult>
