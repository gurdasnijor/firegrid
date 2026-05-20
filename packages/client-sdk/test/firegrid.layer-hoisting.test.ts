// tf-ivl6 / tf-tw49 concern #1: per-contextId RuntimeOutputTable layer
// hoisting. Empirical baseline (PR #450, finding doc) measured 75 of 80
// layer.acquire spans landing on `firegrid.runtimeOutput` with ~2.5x
// amplification per public-surface client call. The refactor caches one
// materialized layer per contextId for the lifetime of the Firegrid
// service; readSnapshot + waitForAgentOutputObservation reuse it via
// `getOutputService` instead of building a fresh layer.
//
// This test exercises the refactored path with K snapshot + wait calls
// on a single session handle and asserts exactly ONE
// `firegrid.durable_table.layer.acquire` span for namespace
// `firegrid.runtimeOutput` — the invariant the cache guarantees. Before
// the refactor the count grew linearly with K.
//
// The codex-acp-tool-calls sim that produced the baseline trace is
// currently broken on main (PR #436 host-projection-observer requires
// RuntimeAgentOutputAfterEvents which the FiregridLocalHostLive
// composition does not provide at the top level; reproducible on a
// pristine origin/main worktree). Trace-shaped evidence is captured
// here directly via a Tracer.Tracer instead.
import {
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  makeLocalRuntimeContextForHostSession,
  makeHostSessionRow,
  normalizeRuntimeIntent,
  runtimeContextRequestId,
  runtimeControlPlaneStreamUrl,
  runtimeContextOutputStreamUrl,
  type HostId,
  type HostSessionId,
} from "@firegrid/protocol/launch"
import {
  encodeRuntimeAgentOutputEnvelope,
  type AgentOutputEvent,
} from "@firegrid/protocol/session-facade"
import { Effect, Layer, Option, Tracer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { TestStreamServer } from "../../effect-durable-operators/test/harness.ts"
import {
  Firegrid,
  FiregridConfig,
  FiregridLive,
} from "../src/firegrid.ts"

let server: TestStreamServer | undefined
let baseUrl: string | undefined

beforeEach(async () => {
  server = new TestStreamServer()
  baseUrl = await server.start()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  baseUrl = undefined
})

interface CapturedSpan {
  readonly name: string
  readonly attributes: Record<string, unknown>
}

const capturingTracerLayer = (
  capturedSpans: Array<CapturedSpan>,
): Layer.Layer<never> => {
  const tracer: Tracer.Tracer = {
    [Tracer.TracerTypeId]: Tracer.TracerTypeId,
    span: (name, parent, context, links, startTime, kind) => {
      const attributes: Record<string, unknown> = {}
      capturedSpans.push({ name, attributes })
      const span: Tracer.Span = {
        _tag: "Span",
        name,
        spanId: `cap-${Math.random().toString(36).slice(2, 10)}`,
        traceId: "cap-trace",
        parent,
        context,
        status: { _tag: "Started", startTime },
        attributes: new Map<string, unknown>(),
        links,
        sampled: true,
        kind,
        end: () => {},
        attribute: (key, value) => {
          attributes[key] = value
        },
        event: () => {},
        addLinks: () => {},
      }
      return span
    },
    context: (f) => f(),
  }
  return Layer.setTracer(tracer)
}

const runtimeConfig = () => ({
  provider: "local-process" as const,
  config: {
    argv: [process.execPath, "--version"],
    agentProtocol: "stdio-jsonl" as const,
  },
})

const agentOutputRaw = (event: AgentOutputEvent): string =>
  encodeRuntimeAgentOutputEnvelope(event)

const makeFixture = () => {
  if (baseUrl === undefined) throw new Error("server not started")
  const namespace = `client-layer-hoist-${crypto.randomUUID()}`
  const hostSession = makeHostSessionRow({
    hostId: `host_${crypto.randomUUID()}` as HostId,
    hostSessionId: `session-${crypto.randomUUID()}` as HostSessionId,
    namespace,
    startedAtMs: Date.now(),
  })
  const capturedSpans: Array<CapturedSpan> = []
  const clientLayer = FiregridLive.pipe(
    Layer.provide(Layer.succeed(FiregridConfig, {
      durableStreamsBaseUrl: baseUrl,
      namespace,
    })),
    Layer.provideMerge(RuntimeControlPlaneTable.layer({
      streamOptions: {
        url: runtimeControlPlaneStreamUrl({ baseUrl, namespace }),
        contentType: "application/json",
      },
    })),
    Layer.provideMerge(capturingTracerLayer(capturedSpans)),
  )
  return { hostSession, clientLayer, capturedSpans, namespace }
}

const runWithClient = <A, E>(
  fixture: ReturnType<typeof makeFixture>,
  effect: Effect.Effect<A, E, Firegrid | RuntimeControlPlaneTable>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(fixture.clientLayer),
      ),
    ),
  )

// Pre-write a context + agent output row through a SEPARATE runtime so
// the test helper's own RuntimeOutputTable.layer build is NOT counted
// against the client-side cache assertion. Mirrors what a host would
// have done before the client opens the session.
const preSeedContextAndOutput = (
  fixture: ReturnType<typeof makeFixture>,
  contextId: string,
  rows: ReadonlyArray<{ sequence: number; event: AgentOutputEvent }>,
): Promise<void> => {
  if (baseUrl === undefined) throw new Error("server not started")
  const controlLayer = RuntimeControlPlaneTable.layer({
    streamOptions: {
      url: runtimeControlPlaneStreamUrl({
        baseUrl,
        namespace: fixture.namespace,
      }),
      contentType: "application/json",
    },
  })
  const outputLayer = RuntimeOutputTable.layer({
    streamOptions: {
      url: runtimeContextOutputStreamUrl({
        baseUrl,
        prefix: fixture.hostSession.streamPrefix,
        contextId,
      }),
      contentType: "application/json",
    },
  })
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const control = yield* RuntimeControlPlaneTable
        const request = yield* control.contextRequests.get(
          runtimeContextRequestId(contextId),
        )
        if (Option.isNone(request)) {
          return yield* Effect.fail(
            new Error(`missing context request for ${contextId}`),
          )
        }
        const createdAtMs = Date.parse(request.value.createdAt)
        const runtimeContext = yield* makeLocalRuntimeContextForHostSession(
          fixture.hostSession,
          normalizeRuntimeIntent(request.value.runtime),
          {
            contextId,
            createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
            ...(request.value.createdBy === undefined
              ? {}
              : { createdBy: request.value.createdBy }),
          },
        )
        yield* control.contexts.insertOrGet(runtimeContext)

        const output = yield* RuntimeOutputTable
        yield* Effect.forEach(rows, ({ sequence, event }) =>
          output.events.upsert({
            eventId: {
              contextId,
              activityAttempt: 1,
              target: "events",
              sequence,
            },
            contextId,
            activityAttempt: 1,
            sequence,
            source: "stdout",
            format: "jsonl",
            receivedAt: new Date().toISOString(),
            raw: agentOutputRaw(event),
          }),
        )
      }).pipe(
        Effect.provide(Layer.mergeAll(controlLayer, outputLayer)),
      ),
    ),
  )
}

const isRuntimeOutputLayerAcquire = (span: CapturedSpan): boolean =>
  span.name === "firegrid.durable_table.layer.acquire" &&
  span.attributes["firegrid.durable_table.namespace"] === "firegrid.runtimeOutput"

describe("Firegrid client RuntimeOutputTable layer hoisting (tf-ivl6 concern #1)", () => {
  it("caches one runtimeOutput layer per contextId across multiple snapshot + wait calls on the same handle", async () => {
    const fixture = makeFixture()

    // Phase 1 (captured): open the session through Firegrid so the
    // contextRequest is durable. No snapshot/wait here — the cache
    // stays cold.
    const phase1 = await runWithClient(
      fixture,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        const session = yield* firegrid.sessions.createOrLoad({
          externalKey: { source: "linear", id: "LIN-layer-hoist" },
          runtime: runtimeConfig(),
        })
        return { sessionId: session.sessionId, contextId: session.contextId }
      }),
    )

    // Phase 2 (separate runtime, NOT traced): pre-seed the runtime
    // context row + one agent-output row. Isolated from the capture so
    // the test helper's own RuntimeOutputTable.layer build is not
    // counted against the client-side cache invariant.
    await preSeedContextAndOutput(fixture, phase1.contextId, [
      { sequence: 1, event: { _tag: "Status", kind: "hoist-1" } },
    ])

    // Reset captures: Phase 3 below is the only one asserted on.
    fixture.capturedSpans.length = 0

    // Phase 3 (captured, fresh client runtime): attach to the session
    // and do K=4 snapshot + wait calls on the same handle. Pre-refactor
    // this acquired the runtimeOutput layer 4 times (one per call, each
    // under its own Effect.scoped). After the refactor the service-
    // scope cache provisions a single layer reused across all calls on
    // the same contextId.
    await runWithClient(
      fixture,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        const handle = yield* firegrid.sessions.attach({
          sessionId: phase1.sessionId,
        })
        const snap1 = yield* handle.snapshot()
        const wait1 = yield* handle.wait.forAgentOutput({ timeoutMs: 1_000 })
        const snap2 = yield* handle.snapshot()
        const wait2 = yield* handle.wait.forAgentOutput({ timeoutMs: 1_000 })
        return { snap1, snap2, wait1, wait2 }
      }),
    )

    const runtimeOutputAcquires =
      fixture.capturedSpans.filter(isRuntimeOutputLayerAcquire)

    expect(
      runtimeOutputAcquires.length,
      "Expected exactly 1 runtimeOutput layer.acquire for K=4 snapshot+wait calls " +
        `on the same session handle; got ${runtimeOutputAcquires.length}. ` +
        "Pre-tf-ivl6 baseline would have been 4.",
    ).toBe(1)
  })

  it("acquires the runtimeOutput layer on demand only (no acquire before first snapshot/wait)", async () => {
    const fixture = makeFixture()

    // Open session WITHOUT snapshot/wait. The cache should be cold;
    // expect 0 runtimeOutput acquires inside the captured runtime.
    await runWithClient(
      fixture,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        yield* firegrid.sessions.createOrLoad({
          externalKey: { source: "linear", id: "LIN-layer-hoist-lazy" },
          runtime: runtimeConfig(),
        })
        return null
      }),
    )

    const acquiresLazy =
      fixture.capturedSpans.filter(isRuntimeOutputLayerAcquire)
    expect(
      acquiresLazy.length,
      "Expected 0 runtimeOutput layer.acquires when only createOrLoad is " +
        `called (no snapshot/wait); got ${acquiresLazy.length}.`,
    ).toBe(0)
  })
})
