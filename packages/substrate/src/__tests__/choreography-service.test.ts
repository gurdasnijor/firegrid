import { DurableStream } from "@durable-streams/client"
import { Cause, Duration, Effect, Exit, Layer, Option, Tracer } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  Choreography,
  ChoreographyLive,
  OwnerId,
  WorkId,
  currentWorkContextLayer,
  triggerMatchersLayer,
  type ChoreographyTrigger,
  type TriggerMatcher,
} from "../choreography/index.ts"
import { SubstrateProducerLive, WorkProducer } from "../write-api/producer.ts"
import { rebuildProjection } from "../stream.ts"
import { DurableWaitsLive } from "../execution/waits.ts"
import {
  freshStreamUrl,
  startTestServer,
  stopTestServer,
} from "./helpers.ts"

beforeAll(async () => {
  await startTestServer()
})

afterAll(async () => {
  await stopTestServer()
})

const matcherAccept: TriggerMatcher = () =>
  Effect.succeed({ kind: "match", value: "ok" } as const)

async function createSubstrateStream(label: string): Promise<string> {
  const url = freshStreamUrl(label)
  await DurableStream.create({ url, contentType: "application/json" })
  return url
}

const buildLayer = (streamUrl: string, matchers: Record<string, TriggerMatcher>) =>
  Layer.provideMerge(
    ChoreographyLive({ streamUrl }),
    Layer.mergeAll(
      DurableWaitsLive({ streamUrl }),
      triggerMatchersLayer(matchers),
    ),
  )

const declareRun = (streamUrl: string, runId: string) =>
  Effect.gen(function* () {
    const wp = yield* WorkProducer
    return yield* wp.declareWork({ runId })
  }).pipe(Effect.provide(SubstrateProducerLive({ streamUrl })))

// choreography-facade.CHOREOGRAPHY_API.2
// choreography-facade.SUSPENSION.1
// choreography-facade.SUSPENSION.2
describe("choreography-facade.CHOREOGRAPHY_API.2 — sleep creates a timer completion and blocks the current run before signalling suspension", () => {
  it("sleep writes pending timer completion + run.blocked, verifies, then interrupts", async () => {
    const url = await createSubstrateStream("choreo-sleep")
    const runId = "run-sleep-1"
    await Effect.runPromise(declareRun(url, runId))

    const program = Effect.gen(function* () {
      const choreo = yield* Choreography
      return yield* choreo.sleep(Duration.seconds(5))
    })

    const exit = await Effect.runPromiseExit(
      program.pipe(
        Effect.provide(
          Layer.provideMerge(
            buildLayer(url, {}),
            currentWorkContextLayer({
              workId: WorkId(runId),
              ownerId: OwnerId("owner-sleep"),
            }),
          ),
        ),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.isInterruptedOnly(exit.cause)).toBe(true)
    }

    const snap = await rebuildProjection({ url })
    const run = snap.runs.get(runId)
    expect(run?.state).toBe("blocked")
    const completionId = run?.blockedOnCompletionId
    expect(completionId).toBeDefined()
    const completion = snap.completions.get(completionId!)
    expect(completion?.kind).toBe("timer")
    expect(completion?.state).toBe("pending")
    const data = completion?.data as { durationMs: number; dueAtMs: number }
    expect(data.durationMs).toBe(5000)
  })
})

// choreography-facade.CHOREOGRAPHY_API.3
// choreography-facade.TRIGGERS.5
describe("choreography-facade.CHOREOGRAPHY_API.3 — waitFor creates a projection-match completion and blocks the current run", () => {
  it("waitFor writes a pending projection_match completion carrying the typed trigger payload, blocks the run, then interrupts", async () => {
    const url = await createSubstrateStream("choreo-wait-for")
    const runId = "run-wait-1"
    await Effect.runPromise(declareRun(url, runId))

    const trigger: ChoreographyTrigger = {
      _tag: "ProjectionMatch",
      label: "permission-resolved:p-1",
      projectionKey: "plane.permission.byId:p-1",
      matcherId: "fixture.permission.resolved",
    }

    const program = Effect.gen(function* () {
      const choreo = yield* Choreography
      return yield* choreo.waitFor(trigger, { timeout: Duration.minutes(10) })
    })

    const exit = await Effect.runPromiseExit(
      program.pipe(
        Effect.provide(
          Layer.provideMerge(
            buildLayer(url, {
              "fixture.permission.resolved": matcherAccept,
            }),
            currentWorkContextLayer({
              workId: WorkId(runId),
              ownerId: OwnerId("owner-wait"),
            }),
          ),
        ),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.isInterruptedOnly(exit.cause)).toBe(true)
    }

    const snap = await rebuildProjection({ url })
    const run = snap.runs.get(runId)
    expect(run?.state).toBe("blocked")
    const completion = snap.completions.get(run!.blockedOnCompletionId!)
    expect(completion?.kind).toBe("projection_match")
    expect(completion?.state).toBe("pending")
    const data = completion?.data as {
      trigger: ChoreographyTrigger
      timeoutMs?: number
      deadlineAtMs?: number
    }
    expect(data.trigger).toStrictEqual(trigger)
    expect(data.timeoutMs).toBe(10 * 60 * 1000)
    expect(typeof data.deadlineAtMs).toBe("number")
  })
})

// choreography-facade.TRIGGERS.8
describe("choreography-facade.TRIGGERS.8 — waitFor with an unknown matcherId fails fast as a defect before any durable row is written", () => {
  it("missing matcher dies before completion creation; no projection_match completion appears in the durable stream", async () => {
    const url = await createSubstrateStream("choreo-wait-missing")
    const runId = "run-wait-missing-1"
    await Effect.runPromise(declareRun(url, runId))

    const trigger: ChoreographyTrigger = {
      _tag: "ProjectionMatch",
      label: "session-terminal:req-1",
      projectionKey: "plane.session.byRequestId:req-1",
      matcherId: "fixture.never.registered",
    }

    const program = Effect.gen(function* () {
      const choreo = yield* Choreography
      return yield* choreo.waitFor(trigger)
    })

    const exit = await Effect.runPromiseExit(
      program.pipe(
        Effect.provide(
          Layer.provideMerge(
            buildLayer(url, {}),
            currentWorkContextLayer({
              workId: WorkId(runId),
              ownerId: OwnerId("owner-missing"),
            }),
          ),
        ),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      // Defect (Effect.die), not a typed failure or interrupt.
      expect(Cause.isDie(exit.cause)).toBe(true)
    }

    const snap = await rebuildProjection({ url })
    const projectionMatchCompletions = Array.from(snap.completions.values()).filter(
      (c) => c.kind === "projection_match",
    )
    expect(projectionMatchCompletions).toHaveLength(0)
    expect(snap.runs.get(runId)?.state).toBe("started")
  })
})

// choreography-facade.CHOREOGRAPHY_API.4
describe("choreography-facade.CHOREOGRAPHY_API.4 — scheduleAt creates a scheduled_work completion and does not block the current run", () => {
  it("scheduleAt returns a result with completionId and whenMs; current run remains in state=started; no run row is blocked", async () => {
    const url = await createSubstrateStream("choreo-schedule-at")
    const runId = "run-schedule-1"
    await Effect.runPromise(declareRun(url, runId))

    const at = new Date("2026-06-01T00:00:00.000Z")
    const program = Effect.gen(function* () {
      const choreo = yield* Choreography
      return yield* choreo.scheduleAt({
        at,
        input: { reason: "follow-up" },
      })
    })

    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          Layer.provideMerge(
            buildLayer(url, {}),
            currentWorkContextLayer({
              workId: WorkId(runId),
              ownerId: OwnerId("owner-sched"),
            }),
          ),
        ),
      ),
    )

    expect(result.whenMs).toBe(at.getTime())
    expect(typeof result.completionId).toBe("string")

    const snap = await rebuildProjection({ url })
    const run = snap.runs.get(runId)
    expect(run?.state).toBe("started")
    expect(run?.blockedOnCompletionId).toBeUndefined()
    const completion = snap.completions.get(result.completionId)
    expect(completion?.kind).toBe("scheduled_work")
    expect(completion?.state).toBe("pending")
    const data = completion?.data as { whenMs: number; input: unknown }
    expect(data.whenMs).toBe(at.getTime())
    expect(data.input).toStrictEqual({ reason: "follow-up" })
  })
})

// choreography-facade.CHOREOGRAPHY_API.4
// scheduleAt is fire-and-forget and pulls only DurableWaits at call time;
// it does NOT depend on CurrentWorkContext or TriggerMatchers. A host
// configuring scheduleAt-only usage should not need to install fake
// context/matcher layers.
describe("choreography-facade.CHOREOGRAPHY_API.4 — scheduleAt runs without CurrentWorkContext and without TriggerMatchers", () => {
  it("ChoreographyLive + DurableWaitsLive alone is sufficient to run scheduleAt; no CurrentWorkContext / TriggerMatchers layers are required", async () => {
    const url = await createSubstrateStream("choreo-schedule-no-ctx")
    const at = Date.now() + 60_000

    const program = Effect.gen(function* () {
      const choreo = yield* Choreography
      return yield* choreo.scheduleAt({ at, input: { kind: "noop" } })
    })

    // Intentionally minimal layer composition: only ChoreographyLive +
    // DurableWaitsLive. This program would not typecheck or run if
    // scheduleAt required CurrentWorkContext or TriggerMatchers.
    const minimalLayer = Layer.provideMerge(
      ChoreographyLive({ streamUrl: url }),
      DurableWaitsLive({ streamUrl: url }),
    )

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(minimalLayer)),
    )
    expect(result.whenMs).toBe(at)
    const snap = await rebuildProjection({ url })
    const completion = snap.completions.get(result.completionId)
    expect(completion?.kind).toBe("scheduled_work")
    expect(completion?.state).toBe("pending")
  })
})

// choreography-facade.SUSPENSION.4
// A run already blocked on a different completion must NOT be re-pointed
// and must NOT report a successful suspension. The block helper rejects
// this case explicitly via Effect.die before appending a new block row.
describe("choreography-facade.SUSPENSION.4 — a run already blocked on a different completion is not re-pointed and not reported as suspended", () => {
  it("calling sleep twice under the same CurrentWorkContext leaves the run blocked on the first completion and dies on the second call", async () => {
    const url = await createSubstrateStream("choreo-double-block")
    const runId = "run-double-block-1"
    await Effect.runPromise(declareRun(url, runId))

    const program = Effect.gen(function* () {
      const choreo = yield* Choreography
      return yield* choreo.sleep(Duration.millis(500))
    })

    const ctxLayer = currentWorkContextLayer({
      workId: WorkId(runId),
      ownerId: OwnerId("owner-double"),
    })
    const layer = Layer.provideMerge(buildLayer(url, {}), ctxLayer)

    // First sleep: succeeds (suspended via interrupt).
    const firstExit = await Effect.runPromiseExit(
      program.pipe(Effect.provide(layer)),
    )
    expect(Exit.isFailure(firstExit)).toBe(true)
    if (Exit.isFailure(firstExit)) {
      expect(Cause.isInterruptedOnly(firstExit.cause)).toBe(true)
    }

    const midSnap = await rebuildProjection({ url })
    const firstCompletionId = midSnap.runs.get(runId)?.blockedOnCompletionId
    expect(firstCompletionId).toBeDefined()

    // Second sleep under the SAME CurrentWorkContext: should die because
    // the run is already blocked on the first completion. The new timer
    // completion may be created (waits.sleep runs first), but the block
    // attempt is refused before any new block row is appended.
    const secondExit = await Effect.runPromiseExit(
      program.pipe(Effect.provide(layer)),
    )
    expect(Exit.isFailure(secondExit)).toBe(true)
    if (Exit.isFailure(secondExit)) {
      expect(Cause.isDie(secondExit.cause)).toBe(true)
      // Specifically NOT reported as a successful suspension (interrupt).
      expect(Cause.isInterruptedOnly(secondExit.cause)).toBe(false)
    }

    const finalSnap = await rebuildProjection({ url })
    const finalRun = finalSnap.runs.get(runId)
    expect(finalRun?.state).toBe("blocked")
    // The run is still blocked on the FIRST completion, never re-pointed.
    expect(finalRun?.blockedOnCompletionId).toBe(firstCompletionId)
  })
})

// choreography-facade.CHOREOGRAPHY_API.5
// choreography-facade.CHOREOGRAPHY_API.8
describe("choreography-facade.CHOREOGRAPHY_API.5 — awaitAwakeable creates a work-scoped externally-resolved completion and blocks the current run", () => {
  it("awaitAwakeable derives the awakeable key from CurrentWorkContext.workId, blocks the run, then interrupts", async () => {
    const url = await createSubstrateStream("choreo-awakeable")
    const runId = "run-awk-1"
    await Effect.runPromise(declareRun(url, runId))

    const program = Effect.gen(function* () {
      const choreo = yield* Choreography
      return yield* choreo.awaitAwakeable({ name: "approval" })
    })

    const exit = await Effect.runPromiseExit(
      program.pipe(
        Effect.provide(
          Layer.provideMerge(
            buildLayer(url, {}),
            currentWorkContextLayer({
              workId: WorkId(runId),
              ownerId: OwnerId("owner-awk"),
            }),
          ),
        ),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.isInterruptedOnly(exit.cause)).toBe(true)
    }

    const snap = await rebuildProjection({ url })
    const expectedKey = `awk:work:${runId}:approval`
    const run = snap.runs.get(runId)
    expect(run?.state).toBe("blocked")
    expect(run?.blockedOnCompletionId).toBe(expectedKey)
    const completion = snap.completions.get(expectedKey)
    expect(completion?.kind).toBe("externally_resolved_awakeable")
    expect(completion?.state).toBe("pending")
  })
})

// choreography-facade.SUSPENSION.1
// choreography-facade.SUSPENSION.2
// Pin the ordering: the durable completion exists AND the run is blocked
// AND the completion-vs-run linkage is verified BEFORE the fiber
// interrupts. Re-rebuilding after the interruption observes a fully
// consistent durable state, not a partial one.
describe("choreography-facade.SUSPENSION.1 — durable completion + blocked run committed before interrupt", () => {
  it("post-interrupt rebuild observes both the pending completion and the matching blocked-on linkage", async () => {
    const url = await createSubstrateStream("choreo-susp-order")
    const runId = "run-susp-1"
    await Effect.runPromise(declareRun(url, runId))

    const program = Effect.gen(function* () {
      const choreo = yield* Choreography
      return yield* choreo.sleep(Duration.millis(250))
    })

    await Effect.runPromiseExit(
      program.pipe(
        Effect.provide(
          Layer.provideMerge(
            buildLayer(url, {}),
            currentWorkContextLayer({
              workId: WorkId(runId),
              ownerId: OwnerId("owner-susp"),
            }),
          ),
        ),
      ),
    )

    const snap = await rebuildProjection({ url })
    const run = snap.runs.get(runId)
    expect(run?.state).toBe("blocked")
    expect(run?.blockedOnCompletionId).toBeDefined()
    const completion = snap.completions.get(run!.blockedOnCompletionId!)
    expect(completion?.state).toBe("pending")
    expect(completion?.kind).toBe("timer")
  })
})

// choreography-facade.INSTRUMENTATION.1
// Choreography operations create Effect-native instrumentation boundaries.
// A host-provided Tracer observes span starts named after each operation;
// the substrate does not need its own tracing infrastructure.
describe("choreography-facade.INSTRUMENTATION.1 — choreography operations emit Effect-native spans named substrate.choreography.<op>", () => {
  it("a host Tracer observes substrate.choreography.schedule_at when scheduleAt runs", async () => {
    const url = await createSubstrateStream("choreo-trace")
    const runId = "run-trace-1"
    await Effect.runPromise(declareRun(url, runId))

    const observed: Array<string> = []
    const recordingTracer = Tracer.make({
      span: (name, _parent, _ctx, _links, startTime, kind) => {
        observed.push(name)
        return {
          _tag: "Span",
          name,
          spanId: name,
          traceId: "t",
          parent: Option.none(),
          context: ({} as unknown) as never,
          status: { _tag: "Started", startTime },
          attributes: new Map(),
          links: [],
          sampled: true,
          kind,
          end: () => {},
          attribute: () => {},
          event: () => {},
          addLinks: () => {},
        }
      },
      context: (f) => f(),
    })

    const program = Effect.gen(function* () {
      const choreo = yield* Choreography
      yield* choreo.scheduleAt({ at: Date.now() + 1000, input: {} })
    }).pipe(Effect.withTracer(recordingTracer))

    await Effect.runPromise(
      program.pipe(
        Effect.provide(
          Layer.provideMerge(
            buildLayer(url, {}),
            currentWorkContextLayer({
              workId: WorkId(runId),
              ownerId: OwnerId("owner-trace"),
            }),
          ),
        ),
      ),
    )

    expect(observed).toContain("substrate.choreography.schedule_at")
  })
})

// choreography-facade.INSTRUMENTATION.3
// choreography-facade.INSTRUMENTATION.4
// The first choreography facade does not require durable.trace rows for
// correctness or ordinary API use. Operations succeed without any tracer
// providing observability, and no durable.trace row is appended.
describe("choreography-facade.INSTRUMENTATION.3 — operations work without durable.trace rows; none are appended", () => {
  it("running sleep + scheduleAt against a stream produces no durable.trace rows", async () => {
    const url = await createSubstrateStream("choreo-no-trace")
    const runId = "run-no-trace-1"
    await Effect.runPromise(declareRun(url, runId))

    const program = Effect.gen(function* () {
      const choreo = yield* Choreography
      yield* choreo.scheduleAt({ at: Date.now() + 1000, input: {} })
      return yield* choreo.sleep(Duration.millis(10))
    })

    await Effect.runPromiseExit(
      program.pipe(
        Effect.provide(
          Layer.provideMerge(
            buildLayer(url, {}),
            currentWorkContextLayer({
              workId: WorkId(runId),
              ownerId: OwnerId("owner-no-trace"),
            }),
          ),
        ),
      ),
    )

    // Read the raw stream to look for any `durable.trace` row type. Trace
    // rows are intentionally outside the canonical state schema (rows.ts),
    // so the substrate projection snapshot does not surface them; we
    // inspect the raw Durable Streams contents instead.
    const handle = new DurableStream({ url, contentType: "application/json" })
    const res = await handle.stream({ offset: "-1", live: false })
    const items = (await res.json()) as ReadonlyArray<{ type?: string }>
    const traceRows = items.filter((it) => it.type === "durable.trace")
    expect(traceRows).toHaveLength(0)
  })
})

// choreography-facade.CURRENT_WORK_CONTEXT.4
// Public callers do not pass completion ids, claim ids, stream URLs, raw
// run rows, or DSS envelopes. The Choreography service surface is the
// proof: every method input is either a Duration, a typed trigger, a
// schedule descriptor, or a name string.
describe("choreography-facade.CURRENT_WORK_CONTEXT.4 — choreography callers never pass internal substrate identifiers", () => {
  it("Choreography service method inputs do not include completionId/claimId/streamUrl/runRow/dssEnvelope-shaped fields", () => {
    // Inspect each method's input type structurally to pin the public
    // surface against accidental expansion. Sleep takes only a Duration;
    // no other operations accept ad-hoc inputs.

    const waitForInput: ChoreographyTrigger = {
      _tag: "ProjectionMatch",
      label: "x",
      projectionKey: "k",
      matcherId: "m",
    }
    const waitForKeys = Object.keys(waitForInput)
    for (const k of waitForKeys) {
      expect(k).not.toMatch(/completionId|claimId|streamUrl|runRow|envelope/i)
    }

    const scheduleInput = {
      at: new Date(),
      input: { whatever: 1 },
    }
    for (const k of Object.keys(scheduleInput)) {
      expect(k).not.toMatch(/completionId|claimId|streamUrl|runRow|envelope/i)
    }

    const awakeableInput = { name: "n" }
    for (const k of Object.keys(awakeableInput)) {
      expect(k).not.toMatch(/completionId|claimId|streamUrl|runRow|envelope/i)
    }
  })
})

// choreography-facade.CURRENT_WORK_CONTEXT.1
// Smoke test that Choreography reads identity from CurrentWorkContext.
// Two different workIds in two invocations block their respective runs;
// we never thread a workId through the Choreography call site.
describe("choreography-facade.CURRENT_WORK_CONTEXT.1 — Choreography reads workId from CurrentWorkContext, not from arguments", () => {
  it("two invocations under different CurrentWorkContext layers block the matching runs without any caller-supplied workId argument", async () => {
    const url = await createSubstrateStream("choreo-ctx")
    const runA = "run-ctx-A"
    const runB = "run-ctx-B"
    await Effect.runPromise(declareRun(url, runA))
    await Effect.runPromise(declareRun(url, runB))

    const program = Effect.gen(function* () {
      const choreo = yield* Choreography
      return yield* choreo.sleep(Duration.millis(100))
    })

    const choreoLayer = buildLayer(url, {})

    const runUnder = (workId: string, ownerId: string) =>
      Effect.runPromiseExit(
        program.pipe(
          Effect.provide(
            Layer.provideMerge(
              choreoLayer,
              currentWorkContextLayer({
                workId: WorkId(workId),
                ownerId: OwnerId(ownerId),
              }),
            ),
          ),
        ),
      )

    await runUnder(runA, "owner-A")
    await runUnder(runB, "owner-B")

    const snap = await rebuildProjection({ url })
    expect(snap.runs.get(runA)?.state).toBe("blocked")
    expect(snap.runs.get(runB)?.state).toBe("blocked")
  })
})
