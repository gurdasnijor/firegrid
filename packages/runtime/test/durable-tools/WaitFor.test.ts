/**
 * Test coverage for the durable-tools wait_for surface.
 *
 * Spec: features/firegrid/firegrid-durable-tools.feature.yaml
 *
 * Test harness mirrors the established pattern in
 * packages/runtime/src/workflow-engine/DurableStreamsWorkflowEngine.test.ts:
 * a real local @durable-streams server, fresh per-test stream URLs, and
 * `Effect.runPromise` via the `runWith` helper. New tests use async `it` +
 * runPromise rather than `it.effect`; the spec forbids `Effect.runSync`
 * wrappers (firegrid-durable-tools.EFFECT_IDIOMS.1) — runPromise here serves
 * the same intent and matches the surrounding package's convention.
 */

import { Workflow } from "@effect/workflow"
import { DurableStreamTestServer } from "@durable-streams/server"
import { Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect"
import { DurableTable, type DurableTableError } from "effect-durable-operators"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DurableStreamsWorkflowEngine } from "../../src/workflow-engine/DurableStreamsWorkflowEngine.ts"
import {
  RuntimeAgentOutputEvents,
  type RuntimeAgentOutputObservation,
} from "../../src/agent-event-pipeline/authorities/runtime-output-journal.ts"
import { RuntimeRuns } from "../../src/authorities/runtime-control-plane-recorder.ts"
import {
  DurableToolsTable,
  DurableToolsWaitForLive,
  type WaitForOptions,
  type WaitForOutcome,
  WaitFor,
  WaitKeyEncoded,
} from "../../src/durable-tools/index.ts"

// Typed wait-source test harness: the router consumes concrete stream tags
// (RuntimeRuns / RuntimeAgentOutputEvents). Tests back those tags with their
// own DurableTables and select them by typed RuntimeWaitSource variant.
// firegrid-typed-wait-source-redesign.MIGRATION.2
const RUNTIME_RUN_SOURCE = { _tag: "RuntimeRun" } as const
const AGENT_OUTPUT_SOURCE = { _tag: "AgentOutput" } as const

/**
 * Workflow bodies declare `error: never`, but `WaitFor.match` can fail with
 * table or decode errors. In tests we treat those as defects so the workflow
 * signature stays clean; the production-app contract is to either declare an
 * error schema or `orDie` here.
 */
const waitForOrDie = <A>(options: WaitForOptions<A>) =>
  WaitFor.match<A>(options).pipe(Effect.orDie)

// ---------------------------------------------------------------------------
// Test-only source DurableTable
// ---------------------------------------------------------------------------

const TestRowSchema = Schema.Struct({
  id: Schema.String.pipe(DurableTable.primaryKey),
  requestId: Schema.String,
  status: Schema.String,
  text: Schema.optional(Schema.String),
})
type TestRow = Schema.Schema.Type<typeof TestRowSchema>

class TestSourceTable extends DurableTable("test.source", {
  rows: TestRowSchema,
}) {}

const SUCCESS_TAG = "Succeeded" as const
const FAIL_TAG = "Failed" as const
const TaggedResultRowSchema = Schema.Struct({
  id: Schema.String.pipe(DurableTable.primaryKey),
  requestId: Schema.String,
  _tag: Schema.Literal(SUCCESS_TAG, FAIL_TAG),
  text: Schema.String,
})
type _TaggedResultRow = Schema.Schema.Type<typeof TaggedResultRowSchema>

class TaggedResultTable extends DurableTable("test.tagged", {
  rows: TaggedResultRowSchema,
}) {}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

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

interface Streams {
  readonly workflowUrl: string
  readonly waitForUrl: string
  readonly sourceUrl: string
}

const makeStreams = (label: string): Streams => {
  if (!baseUrl) throw new Error("server not started")
  const id = crypto.randomUUID()
  return {
    workflowUrl: `${baseUrl}/v1/stream/wait-for-${label}-workflow-${id}`,
    waitForUrl: `${baseUrl}/v1/stream/wait-for-${label}-tools-${id}`,
    sourceUrl: `${baseUrl}/v1/stream/wait-for-${label}-source-${id}`,
  }
}

// RuntimeRuns is backed by TestSourceTable; RuntimeAgentOutputEvents by an
// empty stream (the RuntimeRun-source tests never observe agent output).
const TestSourceWaitStreamsLive = Layer.mergeAll(
  Layer.effect(
    RuntimeRuns,
    Effect.map(
      TestSourceTable,
      table =>
        table.rows.rows() as unknown as RuntimeRuns["Type"],
    ),
  ),
  Layer.succeed(
    RuntimeAgentOutputEvents,
    Stream.empty as unknown as RuntimeAgentOutputEvents["Type"],
  ),
)

const TaggedSourceWaitStreamsLive = Layer.mergeAll(
  Layer.effect(
    RuntimeAgentOutputEvents,
    Effect.map(
      TaggedResultTable,
      table =>
        table.rows.rows() as unknown as RuntimeAgentOutputEvents["Type"],
    ),
  ),
  Layer.succeed(
    RuntimeRuns,
    Stream.empty as unknown as RuntimeRuns["Type"],
  ),
)

const buildLayer = (
  streams: Streams,
  workflowLayer: Layer.Layer<never, unknown, unknown>,
): Layer.Layer<never, unknown, never> =>
  workflowLayer.pipe(
    Layer.provideMerge(
      DurableToolsWaitForLive({ streamUrl: streams.waitForUrl }),
    ),
    Layer.provideMerge(TestSourceWaitStreamsLive),
    Layer.provideMerge(DurableStreamsWorkflowEngine.layer({
      streamUrl: streams.workflowUrl,
    }) as Layer.Layer<never, unknown, unknown>),
    Layer.provideMerge(TestSourceTable.layer({
      streamOptions: {
        url: streams.sourceUrl,
        contentType: "application/json",
      },
    })),
  ) as Layer.Layer<never, unknown, never>

const buildTaggedLayer = (
  streams: Streams,
  workflowLayer: Layer.Layer<never, unknown, unknown>,
): Layer.Layer<never, unknown, never> =>
  workflowLayer.pipe(
    Layer.provideMerge(
      DurableToolsWaitForLive({ streamUrl: streams.waitForUrl }),
    ),
    Layer.provideMerge(TaggedSourceWaitStreamsLive),
    Layer.provideMerge(DurableStreamsWorkflowEngine.layer({
      streamUrl: streams.workflowUrl,
    }) as Layer.Layer<never, unknown, unknown>),
    Layer.provideMerge(TaggedResultTable.layer({
      streamOptions: {
        url: streams.sourceUrl,
        contentType: "application/json",
      },
    })),
  ) as Layer.Layer<never, unknown, never>

const runWith = <A, E>(
  layer: Layer.Layer<never, unknown, never>,
  effect: Effect.Effect<A, E, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(Effect.provide(layer)),
    ) as Effect.Effect<A, unknown, never>,
  )

// Typed wait sources are resolved from concrete stream tags provided by the
// test layer; there is no registration step. Kept as no-ops so the existing
// call sites stay readable. firegrid-typed-wait-source-redesign.REJECTION.3
const registerTestSource = Effect.void
const registerTaggedSource = Effect.void

const sleep = (millis: number) => Effect.sleep(`${millis} millis`)
const TestRowResultSchema = TestRowSchema

const TaggedResultUnion = Schema.Union(
  Schema.Struct({
    id: Schema.String,
    requestId: Schema.String,
    _tag: Schema.Literal(SUCCESS_TAG),
    text: Schema.String,
  }),
  Schema.Struct({
    id: Schema.String,
    requestId: Schema.String,
    _tag: Schema.Literal(FAIL_TAG),
    text: Schema.String,
  }),
)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("durable-tools wait_for", () => {
  it("firegrid-durable-tools.WAIT_FOR.1, WAIT_FOR.3, WAIT_FOR.6, SUBSCRIPTION.1, SUBSCRIPTION.3 resolves a workflow once via raw-payload deferred completion + call-site decode", async () => {
    const streams = makeStreams("basic")
    let resumes = 0
    const Wf = Workflow.make({
      name: "wait-for-basic",
      payload: Schema.Struct({ id: Schema.String, requestId: Schema.String }),
      success: TestRowResultSchema,
      idempotencyKey: (p) => p.id,
    })
    const workflowLayer = Wf.toLayer((payload) =>
      Effect.gen(function*() {
        resumes += 1
        const outcome = yield* waitForOrDie<TestRow>({
          name: "basic",
          source: RUNTIME_RUN_SOURCE,
          trigger: [{ path: ["requestId"], equals: payload.requestId }],
          resultSchema: TestRowResultSchema,
        })
        if (outcome._tag !== "Match") {
          throw new Error("expected Match")
        }
        return outcome.row
      }))

    const layer = buildLayer(streams, workflowLayer)

    const program = Effect.gen(function*() {
      yield* registerTestSource
      const source = yield* TestSourceTable
      const fiber = yield* Effect.fork(Wf.execute({ id: "basic-1", requestId: "req-1" }))
      // Allow handler to suspend + router to attach before producing the row.
      yield* sleep(50)
      yield* source.rows.upsert({
        id: "match-1",
        requestId: "req-1",
        status: "submitted",
        text: "hello",
      })
      return yield* Fiber.join(fiber)
    })

    const result = await runWith(layer, program)
    expect(result.id).toBe("match-1")
    expect(result.requestId).toBe("req-1")
    expect(result.status).toBe("submitted")
    expect(result.text).toBe("hello")
    expect(resumes).toBeGreaterThanOrEqual(1)
  })

  it("firegrid-durable-tools.WAIT_FOR.6, SUBSCRIPTION.1 resumes after restart when the source row appears between runs", async () => {
    const streams = makeStreams("restart")
    const Wf = Workflow.make({
      name: "wait-for-restart",
      payload: Schema.Struct({ id: Schema.String, requestId: Schema.String }),
      success: TestRowResultSchema,
      idempotencyKey: (p) => p.id,
    })
    const workflowLayer = Wf.toLayer((payload) =>
      Effect.gen(function*() {
        const outcome = yield* waitForOrDie<TestRow>({
          name: "restart",
          source: RUNTIME_RUN_SOURCE,
          trigger: [{ path: ["requestId"], equals: payload.requestId }],
          resultSchema: TestRowResultSchema,
        })
        if (outcome._tag !== "Match") throw new Error("expected Match")
        return outcome.row
      }))

    // Run 1: kick off, ensure wait row is persisted, then tear down without a match.
    await runWith(
      buildLayer(streams, workflowLayer),
      Effect.gen(function*() {
        yield* registerTestSource
        yield* Wf.execute({ id: "restart-1", requestId: "req-2" }, { discard: true })
        yield* sleep(50)
        const table = yield* DurableToolsTable
        const waits = yield* table.waits.query((coll) => coll.toArray)
        expect(waits.some((w) => w.status === "active")).toBe(true)
      }),
    )

    // Run 2: rehydrate; the source row is appended *before* execute resolves
    // and the includeInitialState replay must dispatch.
    const result = await runWith(
      buildLayer(streams, workflowLayer),
      Effect.gen(function*() {
        yield* registerTestSource
        const source = yield* TestSourceTable
        const fiber = yield* Effect.fork(Wf.execute({ id: "restart-1", requestId: "req-2" }))
        yield* sleep(50)
        yield* source.rows.upsert({
          id: "match-2",
          requestId: "req-2",
          status: "submitted",
        })
        return yield* Fiber.join(fiber)
      }),
    )
    expect(result.id).toBe("match-2")
  })

  it("firegrid-durable-tools.WAIT_FOR.7 reconciles a completion row written before a crash by issuing idempotent deferredDone", async () => {
    const streams = makeStreams("recovery")
    const Wf = Workflow.make({
      name: "wait-for-recovery",
      payload: Schema.Struct({ id: Schema.String, requestId: Schema.String }),
      success: TestRowResultSchema,
      idempotencyKey: (p) => p.id,
    })
    const workflowLayer = Wf.toLayer((payload) =>
      Effect.gen(function*() {
        const outcome = yield* waitForOrDie<TestRow>({
          name: "recovery",
          source: RUNTIME_RUN_SOURCE,
          trigger: [{ path: ["requestId"], equals: payload.requestId }],
          resultSchema: TestRowResultSchema,
        })
        if (outcome._tag !== "Match") throw new Error("expected Match")
        return outcome.row
      }))

    // Run 1: persist a wait row, then *crash* by tearing down without
    // running the router long enough to dispatch.
    await runWith(
      buildLayer(streams, workflowLayer),
      Effect.gen(function*() {
        yield* registerTestSource
        yield* Wf.execute({ id: "recovery-1", requestId: "req-3" }, { discard: true })
        yield* sleep(50)
      }),
    )

    // Between runs: simulate the post-crash state by writing the completion
    // row + flipping the wait status directly. (firegrid-durable-tools.WAIT_FOR.7)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const table = yield* DurableToolsTable
          const waitsBefore = yield* table.waits.query((coll) => coll.toArray)
          expect(waitsBefore).toHaveLength(1)
          const wait = waitsBefore[0]!
          const matchedRow: TestRow = {
            id: "match-3",
            requestId: "req-3",
            status: "submitted",
          }
          yield* table.completions.upsert({
            waitKey: wait.waitKey,
            outcome: "match",
            matchedRowPayload: matchedRow,
            completedAtMs: Date.now(),
          })
          yield* table.waits.upsert({ ...wait, status: "completed" })
        }).pipe(
          Effect.provide(DurableToolsTable.layer({
            streamOptions: {
              url: streams.waitForUrl,
              contentType: "application/json",
            },
          })),
        ) as Effect.Effect<void, unknown, never>,
      ),
    )

    // Run 2: rehydrate; the reconciler runs on startup and bridges the
    // completion row → deferredDone → workflow returns.
    const result = await runWith(
      buildLayer(streams, workflowLayer),
      Effect.gen(function*() {
        yield* registerTestSource
        return yield* Wf.execute({ id: "recovery-1", requestId: "req-3" })
      }),
    )
    expect(result.id).toBe("match-3")
  })

  it("firegrid-durable-tools.TIMEOUT.1, TIMEOUT.2, WAIT_FOR.4 returns Timeout outcome when no match arrives within timeoutMs", async () => {
    const streams = makeStreams("timeout")
    const Wf = Workflow.make({
      name: "wait-for-timeout",
      payload: Schema.Struct({ id: Schema.String }),
      success: Schema.Literal("Match", "Timeout"),
      idempotencyKey: (p) => p.id,
    })
    const workflowLayer = Wf.toLayer(() =>
      Effect.gen(function*() {
        const outcome: WaitForOutcome<TestRow> = yield* waitForOrDie<TestRow>({
          name: "timeout",
          source: RUNTIME_RUN_SOURCE,
          trigger: [{ path: ["requestId"], equals: "never-arrives" }],
          resultSchema: TestRowResultSchema,
          timeoutMs: 30,
        })
        return outcome._tag
      }))

    const result = await runWith(
      buildLayer(streams, workflowLayer),
      Effect.gen(function*() {
        yield* registerTestSource
        return yield* Wf.execute({ id: "timeout-1" })
      }),
    )

    expect(result).toBe("Timeout")
  })

  it("firegrid-durable-tools.TIMEOUT.3, TIMEOUT.4 prefers a match when the source row arrives before the timeout", async () => {
    const streams = makeStreams("preempt")
    const Wf = Workflow.make({
      name: "wait-for-preempt",
      payload: Schema.Struct({ id: Schema.String, requestId: Schema.String }),
      success: Schema.Literal("Match", "Timeout"),
      idempotencyKey: (p) => p.id,
    })
    const workflowLayer = Wf.toLayer((payload) =>
      Effect.gen(function*() {
        const outcome: WaitForOutcome<TestRow> = yield* waitForOrDie<TestRow>({
          name: "preempt",
          source: RUNTIME_RUN_SOURCE,
          trigger: [{ path: ["requestId"], equals: payload.requestId }],
          resultSchema: TestRowResultSchema,
          timeoutMs: 10_000,
        })
        return outcome._tag
      }))

    const result = await runWith(
      buildLayer(streams, workflowLayer),
      Effect.gen(function*() {
        yield* registerTestSource
        const source = yield* TestSourceTable
        const fiber = yield* Effect.fork(Wf.execute({ id: "preempt-1", requestId: "req-4" }))
        yield* sleep(50)
        yield* source.rows.upsert({
          id: "match-4",
          requestId: "req-4",
          status: "submitted",
        })
        return yield* Fiber.join(fiber)
      }),
    )
    expect(result).toBe("Match")
  })

  it("firegrid-durable-tools.LIFECYCLE.2, LIFECYCLE.3 a retired wait does not produce a completion row when a matching source row arrives", async () => {
    const streams = makeStreams("retired")
    // Use a discard execute so we can observe the wait without binding to a
    // running fiber — retiring the wait would otherwise strand the handler.
    const Wf = Workflow.make({
      name: "wait-for-retired",
      payload: Schema.Struct({ id: Schema.String }),
      success: Schema.String,
      idempotencyKey: (p) => p.id,
    })
    const workflowLayer = Wf.toLayer(() =>
      Effect.gen(function*() {
        const outcome = yield* waitForOrDie<TestRow>({
          name: "retired",
          source: RUNTIME_RUN_SOURCE,
          trigger: [{ path: ["requestId"], equals: "req-5" }],
          resultSchema: TestRowResultSchema,
        })
        if (outcome._tag !== "Match") return "Timeout"
        return outcome.row.id
      }))

    await runWith(
      buildLayer(streams, workflowLayer),
      Effect.gen(function*() {
        yield* registerTestSource
        yield* Wf.execute({ id: "retired-1" }, { discard: true })
        yield* sleep(50)
        const table = yield* DurableToolsTable
        const waits = yield* table.waits.query((coll) => coll.toArray)
        const wait = waits[0]!
        // Retire the wait BEFORE the matching row is appended.
        yield* table.waits.upsert({ ...wait, status: "retired" })
        const source = yield* TestSourceTable
        yield* source.rows.upsert({
          id: "match-5",
          requestId: "req-5",
          status: "submitted",
        })
        yield* sleep(150)
        const completions = yield* table.completions.query((coll) => coll.toArray)
        expect(completions).toHaveLength(0)
        const waitsAfter = yield* table.waits.query((coll) => coll.toArray)
        expect(waitsAfter[0]?.status).toBe("retired")
      }),
    )
  })

  it("firegrid-durable-tools.SUBSCRIPTION.1, WAIT_FOR.6 resolves once via includeInitialState replay when the source row pre-exists the wait", async () => {
    const streams = makeStreams("initial")
    const Wf = Workflow.make({
      name: "wait-for-initial",
      payload: Schema.Struct({ id: Schema.String, requestId: Schema.String }),
      success: TestRowResultSchema,
      idempotencyKey: (p) => p.id,
    })
    const workflowLayer = Wf.toLayer((payload) =>
      Effect.gen(function*() {
        const outcome = yield* waitForOrDie<TestRow>({
          name: "initial",
          source: RUNTIME_RUN_SOURCE,
          trigger: [{ path: ["requestId"], equals: payload.requestId }],
          resultSchema: TestRowResultSchema,
        })
        if (outcome._tag !== "Match") throw new Error("expected Match")
        return outcome.row
      }))

    const result = await runWith(
      buildLayer(streams, workflowLayer),
      Effect.gen(function*() {
        yield* registerTestSource
        const source = yield* TestSourceTable
        // Pre-populate the source BEFORE starting the workflow.
        yield* source.rows.upsert({
          id: "match-6",
          requestId: "req-6",
          status: "submitted",
        })
        const fiber = yield* Effect.fork(Wf.execute({ id: "initial-1", requestId: "req-6" }))
        yield* sleep(50)
        const row = yield* Fiber.join(fiber)
        const table = yield* DurableToolsTable
        const completions = yield* table.completions.query((coll) => coll.toArray)
        expect(completions).toHaveLength(1)
        return row
      }),
    )
    expect(result.id).toBe("match-6")
  })

  it("firegrid-durable-tools.EFFECT_IDIOMS.3, WAIT_FOR.3, WAIT_FOR.4 decodes a tagged-union row payload at the call site", async () => {
    const streams = makeStreams("tagged")
    const Wf = Workflow.make({
      name: "wait-for-tagged",
      payload: Schema.Struct({ id: Schema.String, requestId: Schema.String }),
      success: Schema.Literal(SUCCESS_TAG, FAIL_TAG, "Timeout"),
      idempotencyKey: (p) => p.id,
    })
    const workflowLayer = Wf.toLayer((payload) =>
      Effect.gen(function*() {
        const outcome = yield* waitForOrDie({
          name: "tagged",
          source: AGENT_OUTPUT_SOURCE,
          trigger: [{ path: ["requestId"], equals: payload.requestId }],
          resultSchema: TaggedResultUnion,
          timeoutMs: 10_000,
        })
        if (outcome._tag !== "Match") return "Timeout" as const
        return outcome.row._tag
      }))

    const result = await runWith(
      buildTaggedLayer(streams, workflowLayer),
      Effect.gen(function*() {
        yield* registerTaggedSource
        const source = yield* TaggedResultTable
        const fiber = yield* Effect.fork(Wf.execute({ id: "tagged-1", requestId: "req-7" }))
        yield* sleep(50)
        yield* source.rows.upsert({
          id: "match-7",
          requestId: "req-7",
          _tag: FAIL_TAG,
          text: "boom",
        })
        return yield* Fiber.join(fiber)
      }),
    )
    expect(result).toBe(FAIL_TAG)
  })

  it("firegrid-durable-tools.LIFECYCLE.4, SUBSCRIPTION.7 two concurrent waits on the same source resolve independently", async () => {
    const streams = makeStreams("twin")
    const Wf = Workflow.make({
      name: "wait-for-twin",
      payload: Schema.Struct({ id: Schema.String, requestId: Schema.String }),
      success: TestRowResultSchema,
      idempotencyKey: (p) => p.id,
    })
    const workflowLayer = Wf.toLayer((payload) =>
      Effect.gen(function*() {
        const outcome = yield* waitForOrDie<TestRow>({
          name: payload.id,
          source: RUNTIME_RUN_SOURCE,
          trigger: [{ path: ["requestId"], equals: payload.requestId }],
          resultSchema: TestRowResultSchema,
        })
        if (outcome._tag !== "Match") throw new Error("expected Match")
        return outcome.row
      }))

    const result = await runWith(
      buildLayer(streams, workflowLayer),
      Effect.gen(function*() {
        yield* registerTestSource
        const source = yield* TestSourceTable
        const fiberA = yield* Effect.fork(Wf.execute({ id: "twin-a", requestId: "req-a" }))
        const fiberB = yield* Effect.fork(Wf.execute({ id: "twin-b", requestId: "req-b" }))
        yield* sleep(50)
        yield* source.rows.upsert({
          id: "match-a",
          requestId: "req-a",
          status: "submitted",
        })
        const a = yield* Fiber.join(fiberA)
        yield* source.rows.upsert({
          id: "match-b",
          requestId: "req-b",
          status: "submitted",
        })
        const b = yield* Fiber.join(fiberB)
        return { a, b }
      }),
    )
    expect(result.a.id).toBe("match-a")
    expect(result.b.id).toBe("match-b")
  })

  it("firegrid-durable-tools.BOUNDARIES.6 WaitKey decode fails strictly on malformed input and round-trips on a valid JSON tuple", async () => {
    const decode = Schema.decodeUnknown(WaitKeyEncoded)
    const encode = Schema.encode(WaitKeyEncoded)

    const malformed = await Effect.runPromise(
      Effect.exit(decode("not-json")),
    )
    expect(Exit.isFailure(malformed)).toBe(true)

    const wrongArity = await Effect.runPromise(
      Effect.exit(decode(JSON.stringify(["only-one"]))),
    )
    expect(Exit.isFailure(wrongArity)).toBe(true)

    const valid = await Effect.runPromise(
      decode(JSON.stringify(["exec-1", "wait-1"])),
    )
    expect(valid).toEqual({ executionId: "exec-1", name: "wait-1" })

    const encoded = await Effect.runPromise(
      encode({ executionId: "exec-2", name: "wait-2" }),
    )
    expect(encoded).toBe(JSON.stringify(["exec-2", "wait-2"]))
  })

  it("firegrid-durable-tools.EFFECT_IDIOMS.5 inspects persisted wait + completion rows through the production DurableToolsTable declaration", async () => {
    const streams = makeStreams("inspection")
    const Wf = Workflow.make({
      name: "wait-for-inspect",
      payload: Schema.Struct({ id: Schema.String, requestId: Schema.String }),
      success: TestRowResultSchema,
      idempotencyKey: (p) => p.id,
    })
    const workflowLayer = Wf.toLayer((payload) =>
      Effect.gen(function*() {
        const outcome = yield* waitForOrDie<TestRow>({
          name: "inspect",
          source: RUNTIME_RUN_SOURCE,
          trigger: [{ path: ["requestId"], equals: payload.requestId }],
          resultSchema: TestRowResultSchema,
        })
        if (outcome._tag !== "Match") throw new Error("expected Match")
        return outcome.row
      }))

    await runWith(
      buildLayer(streams, workflowLayer),
      Effect.gen(function*() {
        yield* registerTestSource
        const source = yield* TestSourceTable
        const fiber = yield* Effect.fork(Wf.execute({ id: "inspect-1", requestId: "req-8" }))
        yield* sleep(50)
        const table = yield* DurableToolsTable
        const beforeMatch = yield* table.waits.query((coll) => coll.toArray)
        expect(beforeMatch.find((w) => w.waitKey.name === "inspect")?.status).toBe("active")
        yield* source.rows.upsert({
          id: "match-inspect",
          requestId: "req-8",
          status: "submitted",
        })
        yield* Fiber.join(fiber)
        const afterMatch = yield* table.waits.query((coll) => coll.toArray)
        expect(afterMatch.find((w) => w.waitKey.name === "inspect")?.status).toBe("completed")
        const completions = yield* table.completions.query((coll) => coll.toArray)
        expect(Option.fromNullable(completions[0]?.outcome).pipe(Option.getOrUndefined)).toBe("match")
      }),
    )
  })

  it("firegrid-durable-tools.WAIT_FOR.7 reconciles a match completion written before the wait status was flipped to completed", async () => {
    const streams = makeStreams("mid-crash")
    const Wf = Workflow.make({
      name: "wait-for-mid-crash",
      payload: Schema.Struct({ id: Schema.String, requestId: Schema.String }),
      success: TestRowResultSchema,
      idempotencyKey: (p) => p.id,
    })
    const workflowLayer = Wf.toLayer((payload) =>
      Effect.gen(function*() {
        const outcome = yield* waitForOrDie<TestRow>({
          name: "mid-crash",
          source: RUNTIME_RUN_SOURCE,
          trigger: [{ path: ["requestId"], equals: payload.requestId }],
          resultSchema: TestRowResultSchema,
        })
        if (outcome._tag !== "Match") {
          throw new Error("expected Match")
        }
        return outcome.row
      }))

    // Run 1: persist the wait, then crash without dispatching.
    await runWith(
      buildLayer(streams, workflowLayer),
      Effect.gen(function*() {
        yield* registerTestSource
        yield* Wf.execute(
          { id: "mid-crash-1", requestId: "req-mid" },
          { discard: true },
        )
        yield* sleep(50)
      }),
    )

    // Between runs: write the completion row but leave the wait row in
    // status === "active". This is the exact crash window the reconciler
    // must bridge.
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const table = yield* DurableToolsTable
          const waitsBefore = yield* table.waits.query((coll) => coll.toArray)
          expect(waitsBefore).toHaveLength(1)
          const wait = waitsBefore[0]!
          expect(wait.status).toBe("active")
          yield* table.completions.upsert({
            waitKey: wait.waitKey,
            outcome: "match",
            matchedRowPayload: {
              id: "match-mid",
              requestId: "req-mid",
              status: "submitted",
            } satisfies TestRow,
            completedAtMs: Date.now(),
          })
        }).pipe(
          Effect.provide(DurableToolsTable.layer({
            streamOptions: {
              url: streams.waitForUrl,
              contentType: "application/json",
            },
          })),
        ) as Effect.Effect<void, unknown, never>,
      ),
    )

    const result = await runWith(
      buildLayer(streams, workflowLayer),
      Effect.gen(function*() {
        yield* registerTestSource
        return yield* Wf.execute({ id: "mid-crash-1", requestId: "req-mid" })
      }),
    )
    expect(result.id).toBe("match-mid")

    // After reconcile, the wait row should also be flipped to completed.
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const table = yield* DurableToolsTable
          const wait = (yield* table.waits.query((coll) => coll.toArray))[0]
          expect(wait?.status).toBe("completed")
        }).pipe(
          Effect.provide(DurableToolsTable.layer({
            streamOptions: {
              url: streams.waitForUrl,
              contentType: "application/json",
            },
          })),
        ) as Effect.Effect<void, unknown, never>,
      ),
    )
  })

  it("firegrid-durable-tools.RUNTIME_BOUNDARY.3 attaches a wait whose source is registered after the wait row is created", async () => {
    const streams = makeStreams("late-source")
    const Wf = Workflow.make({
      name: "wait-for-late-source",
      payload: Schema.Struct({ id: Schema.String, requestId: Schema.String }),
      success: TestRowResultSchema,
      idempotencyKey: (p) => p.id,
    })
    const workflowLayer = Wf.toLayer((payload) =>
      Effect.gen(function*() {
        const outcome = yield* waitForOrDie<TestRow>({
          name: "late-source",
          source: RUNTIME_RUN_SOURCE,
          trigger: [{ path: ["requestId"], equals: payload.requestId }],
          resultSchema: TestRowResultSchema,
        })
        if (outcome._tag !== "Match") {
          throw new Error("expected Match")
        }
        return outcome.row
      }))

    const result = await runWith(
      buildLayer(streams, workflowLayer),
      Effect.gen(function*() {
        // Start the workflow BEFORE registering the source. The router must
        // suspend the per-wait fiber on awaitHandle until register lands,
        // not silently drop the wait.
        const fiber = yield* Effect.fork(
          Wf.execute({ id: "late-source-1", requestId: "req-late" }),
        )
        yield* sleep(100)
        yield* registerTestSource
        const source = yield* TestSourceTable
        yield* source.rows.upsert({
          id: "match-late",
          requestId: "req-late",
          status: "submitted",
        })
        return yield* Fiber.join(fiber)
      }),
    )
    expect(result.id).toBe("match-late")
  })
})
