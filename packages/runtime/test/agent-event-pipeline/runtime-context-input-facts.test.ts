// sidecar/shape-c-input-facts: behavior coverage for the Shape C input-fact
// source that replaces the per-sequence DurableDeferred input mailbox.
//
// What is under test:
//   - Producers append `RuntimeInputIntentRow`s via `inputIntents.insertOrGet`
//     keyed by `intentId` (== domain input identity).
//   - `RuntimeContextInputFacts.forContext(contextId)` projects those durable
//     facts into a `Stream<RuntimeIngressInputRow>` filtered by contextId,
//     ready for the Shape C handler (CC2) to consume per-key.
//
// The four invariants below are what the OLD path met "only by the single
// host-scoped serializer" (CC1's Q1 brief) and what Shape C must meet without
// a sequencer:
//   1. out-of-order arrival is observed (correlation by inputId, not ordinal),
//   2. duplicate `intentId` is idempotent (one fact, not two),
//   3. cross-context isolation (forContext filter is precise),
//   4. restart reconstruction reads the durable history (no in-memory state).

import { DurableStreamTestServer } from "@durable-streams/server"
import {
  RuntimeControlPlaneTable,
  type RuntimeControlPlaneTableService,
} from "@firegrid/protocol/launch"
import {
  makeRuntimeInputIntentRow,
  type RuntimeIngressInputRow,
  type RuntimeIngressRequest,
  type RuntimeInputIntentRow,
} from "@firegrid/protocol/runtime-ingress"
import { Effect, Layer, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  ingressInputRowFromIntent,
  RuntimeContextInputFacts,
  RuntimeContextInputFactsLive,
} from "../../src/agent-event-pipeline/authorities/runtime-context-input-facts.ts"

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

const controlStreamUrl = (base: string) =>
  `${base}/v1/stream/runtime-input-facts-${crypto.randomUUID()}.firegrid.runtimeControlPlane`

const controlPlaneLayer = (url: string) =>
  RuntimeControlPlaneTable.layer({
    streamOptions: { url, contentType: "application/json" },
  }) as Layer.Layer<RuntimeControlPlaneTable, unknown, never>

const factsLayer = (url: string) =>
  RuntimeContextInputFactsLive.pipe(Layer.provideMerge(controlPlaneLayer(url)))

// `R = unknown` mirrors the pattern from
// `packages/runtime/test/workflow-engine/scheduled-prompt-true-future.test.ts`:
// `RuntimeControlPlaneTable["Type"]` leaks `any` through DurableTable.layer, so
// a precisely-typed R parameter triggers `@typescript-eslint/no-unsafe-argument`
// at the call site. The post-provide cast localizes the unknown to `never`.
const runWithFacts = <A, E>(
  url: string,
  effect: Effect.Effect<A, E, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(factsLayer(url)),
      ) as Effect.Effect<A, unknown, never>,
    ),
  )

const insertIntent = (
  control: RuntimeControlPlaneTableService,
  request: RuntimeIngressRequest,
  intentId: string,
): Effect.Effect<RuntimeInputIntentRow, unknown> =>
  Effect.gen(function* () {
    const intent = makeRuntimeInputIntentRow(request, { intentId })
    yield* control.inputIntents.insertOrGet(intent)
    return intent
  })

const makeRequest = (
  contextId: string,
  payload: unknown,
  extras: Partial<RuntimeIngressRequest> = {},
): RuntimeIngressRequest => ({
  contextId,
  kind: "message",
  authoredBy: "client",
  payload,
  ...extras,
})

const takeFirstN = (
  stream: Stream.Stream<RuntimeIngressInputRow, unknown>,
  n: number,
): Effect.Effect<ReadonlyArray<RuntimeIngressInputRow>, unknown> =>
  stream.pipe(Stream.take(n), Stream.runCollect, Effect.map(chunk => [...chunk]))

describe("runtime-context input-facts (Shape C source)", () => {
  it("emits durable input facts for a contextId regardless of arrival order", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const url = controlStreamUrl(baseUrl)
    const contextId = `ctx_${crypto.randomUUID()}`

    const observed = await runWithFacts(
      url,
      Effect.gen(function* () {
        const control = yield* RuntimeControlPlaneTable
        const facts = yield* RuntimeContextInputFacts
        // Append three intents for the same context in an order that does NOT
        // match their producer-supplied createdAt timestamps. There is no kernel
        // sequencer; observation must converge on identity, not arrival order.
        yield* insertIntent(control, makeRequest(contextId, "second"), "intent-2")
        yield* insertIntent(control, makeRequest(contextId, "first"), "intent-1")
        yield* insertIntent(control, makeRequest(contextId, "third"), "intent-3")

        const rows = yield* takeFirstN(facts.forContext(contextId), 3)
        return rows
      }),
    )

    expect(observed.length).toBe(3)
    // Correlation is by inputId, not arrival order. The Shape C handler keys
    // off inputId to decide identity; we assert all three are present.
    expect(observed.map(r => r.inputId).sort()).toEqual(["intent-1", "intent-2", "intent-3"])
    // No kernel-assigned sequence; the Shape C input fact carries `status:
    // "pending"` and no `sequence` / `sequencedAt`.
    for (const row of observed) {
      expect(row.contextId).toBe(contextId)
      expect(row.status).toBe("pending")
      expect(row.sequence).toBeUndefined()
      expect(row.sequencedAt).toBeUndefined()
    }
  })

  it("delivers a duplicate intentId exactly once (idempotent on insertOrGet)", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const url = controlStreamUrl(baseUrl)
    const contextId = `ctx_${crypto.randomUUID()}`

    const { observed, secondInsert } = await runWithFacts(
      url,
      Effect.gen(function* () {
        const control = yield* RuntimeControlPlaneTable
        const facts = yield* RuntimeContextInputFacts

        const first = yield* insertIntent(control, makeRequest(contextId, "hello"), "dup")
        // Same intentId, same payload — insertOrGet must return the original
        // and the subscriber must see ONE fact, not two.
        const second = yield* insertIntent(control, makeRequest(contextId, "hello"), "dup")

        // Append a sentinel after the duplicate to bound `take(2)`. If the
        // duplicate accidentally produced a second fact, we'd see "dup" twice
        // before "sentinel".
        yield* insertIntent(control, makeRequest(contextId, "after"), "sentinel")

        const rows = yield* takeFirstN(facts.forContext(contextId), 2)
        return { observed: rows, secondInsert: second, first }
      }),
    )

    expect(observed.map(r => r.inputId)).toEqual(["dup", "sentinel"])
    expect(observed[0]?.payload).toBe("hello")
    // The second insertOrGet of the duplicate must surface as the same
    // identity (intentId stable) even though the producer attempted again.
    expect(secondInsert.intentId).toBe("dup")
  })

  it("isolates per-contextId subscriptions (cross-context facts do not leak)", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const url = controlStreamUrl(baseUrl)
    const ctxA = `ctxA_${crypto.randomUUID()}`
    const ctxB = `ctxB_${crypto.randomUUID()}`

    const observed = await runWithFacts(
      url,
      Effect.gen(function* () {
        const control = yield* RuntimeControlPlaneTable
        const facts = yield* RuntimeContextInputFacts

        yield* insertIntent(control, makeRequest(ctxA, "A1"), "a-1")
        yield* insertIntent(control, makeRequest(ctxB, "B1"), "b-1")
        yield* insertIntent(control, makeRequest(ctxA, "A2"), "a-2")
        yield* insertIntent(control, makeRequest(ctxB, "B2"), "b-2")

        const rowsA = yield* takeFirstN(facts.forContext(ctxA), 2)
        const rowsB = yield* takeFirstN(facts.forContext(ctxB), 2)
        return { rowsA, rowsB }
      }),
    )

    expect(observed.rowsA.map(r => r.inputId).sort()).toEqual(["a-1", "a-2"])
    expect(observed.rowsA.every(r => r.contextId === ctxA)).toBe(true)
    expect(observed.rowsB.map(r => r.inputId).sort()).toEqual(["b-1", "b-2"])
    expect(observed.rowsB.every(r => r.contextId === ctxB)).toBe(true)
  })

  it("reconstructs from durable history after a fresh subscription (no in-memory dispatcher)", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const url = controlStreamUrl(baseUrl)
    const contextId = `ctx_${crypto.randomUUID()}`

    // Phase 1: producer-only scope appends three intents. No subscriber is
    // attached; the OLD path would have lost them without a host-scoped
    // dispatcher fiber holding state. Shape C must read them from the durable
    // table on next subscription.
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* RuntimeControlPlaneTable
          yield* insertIntent(control, makeRequest(contextId, "before-1"), "before-1")
          yield* insertIntent(control, makeRequest(contextId, "before-2"), "before-2")
          yield* insertIntent(control, makeRequest(contextId, "before-3"), "before-3")
        }).pipe(
          Effect.provide(controlPlaneLayer(url)),
        ) as Effect.Effect<void, unknown, never>,
      ),
    )

    // Phase 2: a fresh subscriber attaches over the SAME durable stream URL —
    // simulating a process restart / second consumer. The handler must see
    // every fact written before it existed.
    const observed = await runWithFacts(
      url,
      Effect.gen(function* () {
        const facts = yield* RuntimeContextInputFacts
        return yield* takeFirstN(facts.forContext(contextId), 3)
      }),
    )

    expect(observed.length).toBe(3)
    expect(observed.map(r => r.inputId).sort()).toEqual([
      "before-1",
      "before-2",
      "before-3",
    ])
  })

  it("ingressInputRowFromIntent preserves identity + optional fields without sequencer fields", () => {
    const request: RuntimeIngressRequest = {
      contextId: "ctx_unit",
      inputId: "input-unit",
      kind: "control",
      authoredBy: "workflow",
      payload: { hello: "world" },
      idempotencyKey: "idem-1",
      metadata: { source: "test" },
    }
    const intent = makeRuntimeInputIntentRow(request, { intentId: "input-unit", createdAt: "2026-05-22T00:00:00.000Z" })

    const row = ingressInputRowFromIntent(intent)

    expect(row.inputId).toBe(intent.intentId)
    expect(row.contextId).toBe(intent.contextId)
    expect(row.kind).toBe(intent.kind)
    expect(row.authoredBy).toBe(intent.authoredBy)
    expect(row.payload).toEqual(intent.payload)
    expect(row.idempotencyKey).toBe(intent.idempotencyKey)
    expect(row.metadata).toEqual(intent.metadata)
    expect(row.createdAt).toBe(intent.createdAt)
    // Shape C does not allocate sequences. The fields are intentionally
    // absent — the handler correlates by inputId.
    expect(row.status).toBe("pending")
    expect(row.sequence).toBeUndefined()
    expect(row.sequencedAt).toBeUndefined()
  })
})
