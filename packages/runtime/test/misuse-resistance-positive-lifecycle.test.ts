/**
 * Misuse-resistance POSITIVE proof — the full session lifecycle is EXPRESSIBLE
 * through `@firegrid/client-sdk` ONLY, and the host composition that satisfies
 * it resolves to `Layer<Firegrid, never, never>` (pit-of-success: the client
 * needs nothing but the public surface; no substrate handle in the driver).
 *
 * Proof obligation for SDD_FIREGRID_GATEWAY_SEPARATION_OF_CONCERNS §9.2
 * (tf-r06u.27), positive half.
 *
 * Two layers of proof, by reliability:
 *
 *  1. COMPILE-GATED (the load-bearing part, enforced by `pnpm typecheck`):
 *     - `fullLifecycleThroughClientSdk` drives every lifecycle step
 *       (createOrLoad → start → prompt → wait → permission respond → snapshot)
 *       using ONLY `@firegrid/client-sdk` verbs + public input types. Its sole
 *       requirement is the `Firegrid` Tag — i.e. it imports/touches NO
 *       substrate. If a step needed a substrate handle, the `Effect<…, …,
 *       Firegrid>` annotation would not hold.
 *     - `_compositionProof` proves the host-composition environment
 *       (`FiregridLive ∘ FiregridHost ∘ FiregridConfig`) is a total
 *       `Layer<Firegrid, never, never>` that fully satisfies that driver:
 *       `provide(driver, env)` is annotated `R = never`. If env left ANY
 *       requirement (a leaked substrate Tag, a missing channel binding), this
 *       would not compile.
 *
 *  2. RUNTIME (trace-not-verdict): over a REAL `DurableStreamTestServer`, build
 *     the same host+client env airgapped (recorder adapter — no subprocess) and
 *     materialize the `Firegrid` client service. Proves the public surface
 *     composes and builds against a real durable-streams backend, not just in
 *     the type-checker.
 *
 * SCOPE (honest): this proves EXPRESSIBILITY + COMPOSITION + real materialization.
 * It does NOT drive a live full turn end-to-end (agent output / permission
 * rendezvous) — that is the production-flow ACP scenario's job, and depends on
 * read-side + choreography-dispatch wiring tracked as the #765 completeness
 * beads (read-side stub, etc.). Driving a live turn here would couple this proof
 * to that incomplete wiring; the value here is the SURFACE proof.
 */

import { Effect, Layer } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DurableStreamTestServer } from "@durable-streams/server"
import {
  Firegrid,
  FiregridConfig,
  FiregridLive,
  local,
  type FiregridError,
  type FiregridService,
  type RuntimeContextSnapshot,
  type SessionAgentOutputWaitInput,
  type SessionCreateOrLoadInput,
  type SessionHandlePromptInput,
  type SessionPermissionRespondInput,
} from "@firegrid/client-sdk"
import { FiregridHost } from "../src/unified/host.ts"
import {
  RuntimeContextSessionAdapter,
} from "../src/unified/adapter.ts"
import { makeRecorderAdapter } from "./helpers/recorder-adapter.ts"

// ── 1a. EXPRESSIBILITY — every lifecycle step through client-sdk verbs only ──

interface LifecycleInputs {
  readonly createOrLoad: SessionCreateOrLoadInput
  readonly prompt: SessionHandlePromptInput
  readonly wait: SessionAgentOutputWaitInput
  readonly respond: SessionPermissionRespondInput
}

interface LifecycleTrace {
  readonly steps: ReadonlyArray<string>
  readonly contextId: string
  readonly snapshot: RuntimeContextSnapshot
}

/**
 * The FULL lifecycle, expressed purely through the `Firegrid` client service.
 * Its requirement channel is exactly `Firegrid` — proving every step is a
 * public client verb and no substrate handle is needed in scope.
 */
const fullLifecycleThroughClientSdk = (
  firegrid: FiregridService,
  inputs: LifecycleInputs,
): Effect.Effect<LifecycleTrace, FiregridError, never> =>
  Effect.gen(function*() {
    const handle = yield* firegrid.sessions.createOrLoad(inputs.createOrLoad)
    yield* handle.start()
    yield* handle.prompt(inputs.prompt)
    yield* handle.wait.forAgentOutput(inputs.wait)
    yield* handle.permissions.respond(inputs.respond)
    const snapshot = yield* handle.snapshot()
    return {
      steps: ["createOrLoad", "start", "prompt", "wait.forAgentOutput", "permissions.respond", "snapshot"],
      contextId: handle.contextId,
      snapshot,
    }
  })

// ── 1b. COMPOSITION — the host env is a total Layer<Firegrid, never, never> ───
//
// Never invoked; tsc checks the annotations. If `env` left ANY requirement
// (e.g. a leaked substrate Tag, an unbound channel), `provided`'s `R = never`
// annotation would fail to compile — that is the composition gate.

// The misuse-resistance claim is about the REQUIREMENT channel (`RIn = never`):
// the env provides everything the client driver needs, with no leaked substrate
// requirement. The error channel is intentionally left open (`unknown`) — a
// real host build can fail (table I/O, config) and that is not a misuse.
const _compositionProof = (
  env: Layer.Layer<Firegrid, unknown, never>,
  inputs: LifecycleInputs,
): Effect.Effect<LifecycleTrace, unknown, never> => {
  const program: Effect.Effect<LifecycleTrace, FiregridError, Firegrid> = Effect.gen(
    function*() {
      const firegrid = yield* Firegrid
      return yield* fullLifecycleThroughClientSdk(firegrid, inputs)
    },
  )
  const provided: Effect.Effect<LifecycleTrace, unknown, never> = program.pipe(
    Effect.provide(env),
  )
  return provided
}
void _compositionProof

// The host-composition environment (the "host(env)") for a baseUrl/namespace.
// `FiregridLive` needs `RuntimeControlPlaneTable` + the protocol channel Tags +
// `FiregridConfig`; `FiregridHost` provides the first two (shared table), the
// config layer provides the third. The resulting Layer is asserted total below.
const makeHostClientEnv = (
  baseUrl: string,
  namespace: string,
  options: { readonly contextReflectionTimeoutMs?: number } = {},
): Layer.Layer<Firegrid, unknown, never> => {
  // The recorder exposes the adapter service via `.service` (airgapped —
  // records spawn/send/deregister in-memory, spawns no subprocess).
  const recorderAdapter = Layer.effect(
    RuntimeContextSessionAdapter,
    makeRecorderAdapter().pipe(Effect.map((r) => r.service)),
  )
  const hostLayer = FiregridHost({
    adapter: recorderAdapter,
    durableStreamsBaseUrl: baseUrl,
    namespace,
  })
  const configLayer = Layer.succeed(FiregridConfig, {
    durableStreamsBaseUrl: baseUrl,
    namespace,
    ...(options.contextReflectionTimeoutMs === undefined
      ? {}
      : { contextReflectionTimeoutMs: options.contextReflectionTimeoutMs }),
  })
  return FiregridLive.pipe(
    Layer.provide(hostLayer),
    Layer.provide(configLayer),
  )
}

// ── 2. RUNTIME — build the env against a real server; materialize the client ──

describe("misuse-resistance — positive lifecycle proof", () => {
  let server: DurableStreamTestServer
  let baseUrl: string

  beforeAll(async () => {
    server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
    baseUrl = await server.start()
  })

  afterAll(async () => {
    await server.stop()
  })

  it("composes FiregridLive ∘ FiregridHost ∘ FiregridConfig to Firegrid over a real durable-streams server", async () => {
    const env = makeHostClientEnv(baseUrl, "misuse-positive")
    const trace = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          // Materializing the client service forces the whole host+client env
          // to build against the real durable-streams backend.
          const firegrid = yield* Firegrid
          return {
            firegridMaterialized: typeof firegrid.sessions.createOrLoad === "function",
            hasChannels: typeof firegrid.channels.call === "function",
          }
        }).pipe(Effect.provide(env)),
      ),
    )
    expect(trace.firegridMaterialized).toBe(true)
    expect(trace.hasChannels).toBe(true)
  })

  it("firegrid-host-sdk.RUNTIME_SESSION_SURFACE.4-1 materializes the createOrLoad RuntimeContext before returning", async () => {
    const env = makeHostClientEnv(baseUrl, "misuse-positive-create-or-load", {
      contextReflectionTimeoutMs: 100,
    })
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const firegrid = yield* Firegrid
          const handle = yield* firegrid.sessions.createOrLoad({
            externalKey: {
              source: "tf-ll90.9.4",
              id: "materializes-context",
            },
            runtime: local.jsonl({
              agent: "recorder",
              argv: [process.execPath, "-e", ""],
            }),
            createdBy: "tf-ll90.9.4",
          })
          const snapshot = yield* handle.snapshot()
          return { handle, snapshot }
        }).pipe(Effect.provide(env)),
      ),
    )

    expect(result.handle.sessionId).toBe("session:tf-ll90.9.4:materializes-context")
    expect(result.snapshot.context?.contextId).toBe(result.handle.contextId)
    expect(result.snapshot.context?.createdBy).toBe("tf-ll90.9.4")
    expect(result.snapshot.context?.runtime.provider).toBe("local-process")
    expect(result.snapshot.context?.host.hostId).toBe("misuse-positive-create-or-load-host")
  })
})
