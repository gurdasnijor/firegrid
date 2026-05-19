import { DurableStreamTestServer } from "@durable-streams/server"
import {
  ensurePathInput,
  FiregridMcpServerLayer,
  FiregridRuntimeContextMcpBaseUrl,
  FiregridRuntimeHostLive,
  resolveEffectiveMcpServers,
  RuntimeEnvResolverPolicy,
  runtimeContextMcpUrlForContext,
} from "@firegrid/host-sdk"
import {
  CurrentHostSession,
  firegridRuntimeContextMcpName,
  local,
  makeLocalRuntimeContextForHostSession,
  normalizeRuntimeIntent,
} from "@firegrid/protocol/launch"
import { sessionContextIdForExternalKey } from "@firegrid/protocol/session-facade"
import { Clock, Context, Effect, Exit, Layer, Option } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

// TFIND-048 — DETERMINISTIC CI-gating validation of the host-provisioning
// seam (coordinator correctness-bar ruling, 2026-05-19). Zero real-LLM
// dependence: it asserts exactly the load-bearing seam —
//
//   1. the client expresses ONLY the URL-less `runtimeContextMcp`
//      marker; the materialized durable intent contains NO
//      client-predicted MCP URL anywhere;
//   2. the host provisions the concrete contextId-scoped URL from its
//      OWN bound MCP listener address (real OS-chosen port, not 0, not
//      client-predicted);
//   3. the SAME resolution the resumed codec start path uses
//      (`resolveEffectiveMcpServers`) returns exactly that
//      host-provisioned URL;
//   4. marker + no bound MCP listener fails EXPLICITLY (never a silent
//      skip).
//
// The full real-LLM Codex ACP end-to-end is the documented non-gating
// smoke (`codex-acp-tool-call-pipeline.smoke.ts`), excluded from the CI
// gate because a live LLM's tool-use is nondeterministic.

let server: DurableStreamTestServer | undefined
let baseUrl: string | undefined

beforeEach(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  baseUrl = await server.start()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  baseUrl = undefined
})

const codexAcpArgv = ["node", "noop.mjs"] as const

const hostLayer = (durableStreamsBaseUrl: string, namespace: string) =>
  FiregridMcpServerLayer({
    host: "127.0.0.1",
    port: 0,
    path: ensurePathInput("/mcp"),
  }).pipe(
    Layer.provideMerge(FiregridRuntimeHostLive(
      {
        durableStreamsBaseUrl,
        namespace,
        hostId: "host-a",
        hostSessionId: "host-a-session",
        input: true,
      },
      RuntimeEnvResolverPolicy.denyAll,
    )),
  )

const markerIntent = normalizeRuntimeIntent(local.jsonl({
  argv: [...codexAcpArgv],
  agent: "codex-acp",
  agentProtocol: "acp",
  runtimeContextMcp: { enabled: true },
}))

const noMarkerIntent = normalizeRuntimeIntent(local.jsonl({
  argv: [...codexAcpArgv],
  agent: "codex-acp",
  agentProtocol: "acp",
}))

describe("tiny-firegrid Codex ACP host-provisioning seam (deterministic)", () => {
  it("firegrid-workflow-driven-runtime.PHASE_7_MCP_HOST_SERVER.1 host provisions the contextId-scoped MCP URL; the resumed session resolves THAT url; the client predicts none", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const durableStreamsBaseUrl = baseUrl
    const namespace = `tiny-codex-acp-seam-${crypto.randomUUID()}`
    const contextId = sessionContextIdForExternalKey({
      source: "tiny-firegrid",
      id: "codex-acp-seam",
    })

    const result = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const ctx = yield* Layer.build(
          hostLayer(durableStreamsBaseUrl, namespace),
        )
        const session = Context.get(ctx, CurrentHostSession)
        const baseService = Context.get(
          ctx,
          FiregridRuntimeContextMcpBaseUrl,
        )

        // (2) The host published a REAL bound listener address (the
        // OS-chosen port, resolved post-bind) — never port 0, never
        // client-predicted.
        const base = yield* baseService.get
        const createdAtMs = yield* Clock.currentTimeMillis

        // The materialized context the resumed session would run with
        // (exactly what the reconciler builds from the client request).
        const markedContext = yield* makeLocalRuntimeContextForHostSession(
          session,
          markerIntent,
          { contextId, createdAtMs, createdBy: "tiny-firegrid" },
        )
        const unmarkedContext = yield* makeLocalRuntimeContextForHostSession(
          session,
          noMarkerIntent,
          { contextId, createdAtMs, createdBy: "tiny-firegrid" },
        )

        // (3) The SAME resolution the codec start path uses.
        const effective = yield* resolveEffectiveMcpServers(
          markedContext,
        ).pipe(Effect.provide(ctx))
        const unmarkedEffective = yield* resolveEffectiveMcpServers(
          unmarkedContext,
        ).pipe(Effect.provide(ctx))

        return { base, markedContext, effective, unmarkedEffective }
      })),
    )

    // (2) host-owned bound address, real OS-chosen port, not 0.
    expect(Option.isSome(result.base)).toBe(true)
    const base = Option.getOrThrow(result.base)
    expect(base.basePath).toBe("/mcp")
    expect(base.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const boundPort = Number(new URL(base.address).port)
    expect(boundPort).toBeGreaterThan(0)

    // (1) The materialized durable intent carries ONLY the marker —
    // NO client-predicted MCP URL anywhere.
    expect(result.markedContext.runtime.config.runtimeContextMcp)
      .toEqual({ enabled: true })
    expect(result.markedContext.runtime.config.mcpServers)
      .toBeUndefined()

    // (3) The resumed session resolves EXACTLY the host-provisioned URL.
    const expectedUrl = runtimeContextMcpUrlForContext(base, contextId)
    expect(expectedUrl).toBe(
      `http://127.0.0.1:${boundPort}/mcp/runtime-context/${
        encodeURIComponent(contextId)
      }`,
    )
    expect(result.effective).toEqual([
      {
        name: firegridRuntimeContextMcpName,
        server: { type: "url", url: expectedUrl },
      },
    ])

    // No marker ⇒ no injection, no fabricated URL.
    expect(result.unmarkedEffective).toBeUndefined()
  })

  it("firegrid-workflow-driven-runtime.PHASE_7_MCP_HOST_SERVER.6 marker set but no bound MCP listener fails EXPLICITLY (never a silent skip)", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const durableStreamsBaseUrl = baseUrl
    const namespace = `tiny-codex-acp-seam-none-${crypto.randomUUID()}`
    const contextId = sessionContextIdForExternalKey({
      source: "tiny-firegrid",
      id: "codex-acp-seam-none",
    })

    const exit = await Effect.runPromiseExit(
      Effect.scoped(Effect.gen(function*() {
        // Runtime host WITHOUT FiregridMcpServerLayer: the single-owner
        // base channel defaults to None.
        const ctx = yield* Layer.build(
          FiregridRuntimeHostLive(
            {
              durableStreamsBaseUrl,
              namespace,
              hostId: "host-b",
              hostSessionId: "host-b-session",
              input: true,
            },
            RuntimeEnvResolverPolicy.denyAll,
          ),
        )
        const session = Context.get(ctx, CurrentHostSession)
        const createdAtMs = yield* Clock.currentTimeMillis
        const markedContext = yield* makeLocalRuntimeContextForHostSession(
          session,
          markerIntent,
          { contextId, createdAtMs, createdBy: "tiny-firegrid" },
        )
        return yield* resolveEffectiveMcpServers(markedContext).pipe(
          Effect.provide(ctx),
        )
      })),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })
})
