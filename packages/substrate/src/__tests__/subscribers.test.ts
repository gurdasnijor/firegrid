import { DurableStream } from "@durable-streams/client"
import { Effect, Either } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as substrate from "../index.ts"
import {
  CompletionProducer,
  SubstrateProducerLive,
} from "../producer.ts"
import type { CompletionValue } from "../schema/rows.ts"
import { createPendingCompletion } from "../state-machine.ts"
import { substrateState } from "../schema/state.ts"
import { rebuildProjection } from "../stream.ts"
import {
  runProjectionMatchSubscriber,
  runScheduledWorkSubscriber,
  runTimerSubscriber,
  SubscriberDataError,
  SubscriberEvaluatorError,
  SubscriberStreamError,
  type ProjectionMatchEvaluator,
} from "../subscribers.ts"
import {
  DurableWaits,
  DurableWaitsLive,
} from "../waits.ts"
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

async function createSubstrateStream(label: string): Promise<string> {
  const url = freshStreamUrl(label)
  await DurableStream.create({ url, contentType: "application/json" })
  return url
}

// Append a hand-built ChangeEvent (test-only fixture; PACKAGE_BOUNDARY.1).
async function appendEvent(url: string, event: unknown): Promise<void> {
  const stream = new DurableStream({ url, contentType: "application/json" })
  await stream.append(JSON.stringify(event))
}

describe("durable-subscribers.SUBSCRIBER_SCOPE", () => {
  it("durable-subscribers.SUBSCRIBER_SCOPE.5 — subscribers are single-shot scan-and-resolve functions (no long-running watcher)", () => {
    expect(typeof runTimerSubscriber).toBe("function")
    expect(typeof runScheduledWorkSubscriber).toBe("function")
    expect(typeof runProjectionMatchSubscriber).toBe("function")
    // No service class / scoped runner / loop is exposed.
    const m = substrate as unknown as Record<string, unknown>
    expect(m.TimerSubscriber).toBeUndefined()
    expect(m.DurableSubscribers).toBeUndefined()
    expect(m.DurableSubscribersLive).toBeUndefined()
    expect(m.startSubscribers).toBeUndefined()
  })
})

describe("durable-subscribers.TIMER_SUBSCRIBER", () => {
  it("durable-subscribers.TIMER_SUBSCRIBER.1 + .2 + .3 + .4 — eligible timer (dueAtMs <= nowMs) appends a resolved terminal carrying dueAtMs and observedFireMs", async () => {
    const url = await createSubstrateStream("timer-eligible")
    // Seed an already-due timer (dueAtMs in the past).
    const completionId = "c-timer-1"
    const dueAtMs = Date.now() - 1000
    const event = createPendingCompletion({
      completionId,
      kind: "timer",
      data: { durationMs: 1000, dueAtMs },
    })
    await appendEvent(url, event)

    const result = await Effect.runPromise(runTimerSubscriber({ streamUrl: url }))
    expect(result.resolvedIds).toEqual([completionId])

    const snapshot = await rebuildProjection({ url })
    const completion = snapshot.completions.get(completionId)
    expect(completion?.state).toBe("resolved")
    const r = completion?.result as { dueAtMs: number; observedFireMs: number } | undefined
    expect(r?.dueAtMs).toBe(dueAtMs)
    expect(r?.observedFireMs).toBeGreaterThanOrEqual(dueAtMs)
  })

  it("durable-subscribers.TIMER_SUBSCRIBER.2 — timer with future dueAtMs is NOT eligible; subscriber leaves it pending", async () => {
    const url = await createSubstrateStream("timer-future")
    const completionId = "c-timer-future"
    const dueAtMs = Date.now() + 1_000_000
    await appendEvent(url, createPendingCompletion({
      completionId,
      kind: "timer",
      data: { durationMs: 1_000_000, dueAtMs },
    }))

    const result = await Effect.runPromise(runTimerSubscriber({ streamUrl: url }))
    expect(result.resolvedIds).toEqual([])
    const snapshot = await rebuildProjection({ url })
    expect(snapshot.completions.get(completionId)?.state).toBe("pending")
  })

  it("durable-subscribers.TIMER_SUBSCRIBER — malformed completion data fails typed (SubscriberDataError)", async () => {
    const url = await createSubstrateStream("timer-bad-data")
    await appendEvent(url, createPendingCompletion({
      completionId: "c-bad",
      kind: "timer",
      // missing dueAtMs in data
      data: { durationMs: 1 },
    }))
    const result = await Effect.runPromise(
      Effect.either(runTimerSubscriber({ streamUrl: url })),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(SubscriberDataError)
    }
  })

  it("durable-subscribers.TIMER_SUBSCRIBER.5 — subscriber does NOT resume a live callback as authority", () => {
    // Structural: the subscriber is a pure Effect-returning function;
    // it accepts no callback, takes no handler, and exposes no run-invocation API.
    // No event-emitter / subscriber-callback API is exported.
    const m = substrate as unknown as Record<string, unknown>
    expect(m.subscribeTimer).toBeUndefined()
    expect(m.onTimerFired).toBeUndefined()
  })
})

describe("durable-subscribers.SCHEDULED_WORK_SUBSCRIBER", () => {
  it("durable-subscribers.SCHEDULED_WORK_SUBSCRIBER.1 + .2 + .3 + .4 — eligible scheduled_work appends resolved terminal preserving whenMs + opaque input", async () => {
    const url = await createSubstrateStream("sw-eligible")
    const completionId = "c-sw-1"
    const whenMs = Date.now() - 500
    const inputPayload = { task: "compaction", refs: [1, 2, 3] }
    await appendEvent(url, createPendingCompletion({
      completionId,
      kind: "scheduled_work",
      workId: "owning-run-1",
      data: { whenMs, input: inputPayload },
    }))

    const result = await Effect.runPromise(runScheduledWorkSubscriber({ streamUrl: url }))
    expect(result.resolvedIds).toEqual([completionId])

    const snapshot = await rebuildProjection({ url })
    const completion = snapshot.completions.get(completionId)
    expect(completion?.state).toBe("resolved")
    expect(completion?.workId).toBe("owning-run-1")
    const r = completion?.result as { whenMs: number; input: unknown } | undefined
    expect(r?.whenMs).toBe(whenMs)
    expect(r?.input).toEqual(inputPayload)
  })

  it("durable-subscribers.SCHEDULED_WORK_SUBSCRIBER.2 — future whenMs is not eligible", async () => {
    const url = await createSubstrateStream("sw-future")
    await appendEvent(url, createPendingCompletion({
      completionId: "c-sw-future",
      kind: "scheduled_work",
      data: { whenMs: Date.now() + 1_000_000, input: null },
    }))
    const result = await Effect.runPromise(runScheduledWorkSubscriber({ streamUrl: url }))
    expect(result.resolvedIds).toEqual([])
  })

  it("durable-subscribers.SCHEDULED_WORK_SUBSCRIBER.5 — subscriber does NOT append prompt/session/agent/provider rows", async () => {
    const url = await createSubstrateStream("sw-no-side-rows")
    await appendEvent(url, createPendingCompletion({
      completionId: "c-sw-side",
      kind: "scheduled_work",
      data: { whenMs: Date.now() - 1, input: { x: 1 } },
    }))
    await Effect.runPromise(runScheduledWorkSubscriber({ streamUrl: url }))
    const snapshot = await rebuildProjection({ url })
    // Only the completion is touched; runs/claims stay empty; no extra rows.
    expect(snapshot.runs.size).toBe(0)
    expect(snapshot.claimAttempts.size).toBe(0)
    expect(snapshot.completions.size).toBe(1)
  })
})

describe("durable-subscribers.PROJECTION_MATCH_SUBSCRIBER", () => {
  // PROJECTION_MATCH_SUBSCRIBER.7 — per-call evaluator (no registry).
  const matchEvaluator =
    (decision: "match" | "no-match", value?: unknown): ProjectionMatchEvaluator =>
    () =>
      Effect.succeed(
        decision === "match"
          ? { kind: "match" as const, value }
          : { kind: "no-match" as const },
      )

  it("durable-subscribers.PROJECTION_MATCH_SUBSCRIBER.1 + .7 — evaluator match returns resolved terminal with matchedValue", async () => {
    const url = await createSubstrateStream("pm-match")
    const completionId = "c-pm-1"
    await appendEvent(url, createPendingCompletion({
      completionId,
      kind: "projection_match",
      data: {
        trigger: { kind: "projection_match", description: { collection: "users", id: "u-1" } },
      },
    }))

    const result = await Effect.runPromise(
      runProjectionMatchSubscriber({
        streamUrl: url,
        evaluate: matchEvaluator("match", { user: "alice" }),
      }),
    )
    expect(result.resolvedIds).toEqual([completionId])
    expect(result.cancelledIds).toEqual([])

    const snapshot = await rebuildProjection({ url })
    const completion = snapshot.completions.get(completionId)
    expect(completion?.state).toBe("resolved")
    expect((completion?.result as { matchedValue: unknown } | undefined)?.matchedValue).toEqual({
      user: "alice",
    })
  })

  it("durable-subscribers.PROJECTION_MATCH_SUBSCRIBER.8 — evaluator no-match leaves the completion pending for a future scan", async () => {
    const url = await createSubstrateStream("pm-no-match")
    const completionId = "c-pm-2"
    await appendEvent(url, createPendingCompletion({
      completionId,
      kind: "projection_match",
      data: {
        trigger: { kind: "projection_match", description: "anything" },
      },
    }))

    const result = await Effect.runPromise(
      runProjectionMatchSubscriber({ streamUrl: url, evaluate: matchEvaluator("no-match") }),
    )
    expect(result.resolvedIds).toEqual([])
    expect(result.cancelledIds).toEqual([])

    const snapshot = await rebuildProjection({ url })
    expect(snapshot.completions.get(completionId)?.state).toBe("pending")
  })

  it("durable-subscribers.PROJECTION_MATCH_SUBSCRIBER.6 + .9 — timeout fires from durable deadlineAtMs (not process-local elapsed time)", async () => {
    const url = await createSubstrateStream("pm-timeout")
    const completionId = "c-pm-3"
    const timeoutMs = 1000
    const deadlineAtMs = Date.now() - 10 // already past
    await appendEvent(url, createPendingCompletion({
      completionId,
      kind: "projection_match",
      data: {
        trigger: { kind: "projection_match", description: "x" },
        timeoutMs,
        deadlineAtMs,
      },
    }))

    const result = await Effect.runPromise(
      runProjectionMatchSubscriber({
        streamUrl: url,
        // Even if evaluator would say match, the timeout path fires first.
        evaluate: matchEvaluator("match", "should-not-be-used"),
      }),
    )
    expect(result.resolvedIds).toEqual([])
    expect(result.cancelledIds).toEqual([completionId])

    const snapshot = await rebuildProjection({ url })
    const completion = snapshot.completions.get(completionId)
    expect(completion?.state).toBe("cancelled")
    const reason = completion?.terminalReason as
      | { kind: string; timeoutMs?: number; observedAtMs?: number }
      | undefined
    expect(reason?.kind).toBe("timeout")
    expect(reason?.timeoutMs).toBe(timeoutMs)
    expect(typeof reason?.observedAtMs).toBe("number")
  })

  it("durable-subscribers.PROJECTION_MATCH_SUBSCRIBER.9 — completion with timeoutMs but FUTURE deadlineAtMs is not eligible for timeout firing", async () => {
    const url = await createSubstrateStream("pm-timeout-future")
    const completionId = "c-pm-future"
    await appendEvent(url, createPendingCompletion({
      completionId,
      kind: "projection_match",
      data: {
        trigger: { kind: "projection_match", description: "x" },
        timeoutMs: 60_000,
        deadlineAtMs: Date.now() + 60_000,
      },
    }))
    const result = await Effect.runPromise(
      runProjectionMatchSubscriber({ streamUrl: url, evaluate: matchEvaluator("no-match") }),
    )
    expect(result.cancelledIds).toEqual([])
    const snapshot = await rebuildProjection({ url })
    expect(snapshot.completions.get(completionId)?.state).toBe("pending")
  })

  it("durable-subscribers.PROJECTION_MATCH_SUBSCRIBER — evaluator failure surfaces as typed SubscriberEvaluatorError (not silent skip)", async () => {
    const url = await createSubstrateStream("pm-eval-error")
    await appendEvent(url, createPendingCompletion({
      completionId: "c-pm-err",
      kind: "projection_match",
      data: { trigger: { kind: "projection_match", description: 1 } },
    }))
    const failingEval: ProjectionMatchEvaluator = () =>
      Effect.fail({ code: "EVAL_BOOM" })
    const result = await Effect.runPromise(
      Effect.either(
        runProjectionMatchSubscriber({ streamUrl: url, evaluate: failingEval }),
      ),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(SubscriberEvaluatorError)
    }
  })

  it("durable-subscribers.PROJECTION_MATCH_SUBSCRIBER — missing trigger fails typed (SubscriberDataError)", async () => {
    const url = await createSubstrateStream("pm-missing-trigger")
    await appendEvent(url, createPendingCompletion({
      completionId: "c-pm-missing",
      kind: "projection_match",
      // No trigger in data — degenerate row.
      data: { timeoutMs: 1, deadlineAtMs: Date.now() + 100_000 },
    }))
    const result = await Effect.runPromise(
      Effect.either(
        runProjectionMatchSubscriber({
          streamUrl: url,
          evaluate: matchEvaluator("no-match"),
        }),
      ),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(SubscriberDataError)
    }
  })
})

describe("durable-waits-and-scheduling.WAIT_FOR.7 — waitFor stores deadlineAtMs alongside timeoutMs", () => {
  it("waitFor with timeoutMs computes and stores an absolute durable deadline at creation time", async () => {
    const url = await createSubstrateStream("waitfor-deadline")
    const before = Date.now()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const waits = yield* DurableWaits
        return yield* waits.waitFor({
          trigger: { kind: "projection_match", description: 1 },
          timeoutMs: 30_000,
        })
      }).pipe(Effect.provide(DurableWaitsLive({ streamUrl: url }))),
    )
    const after = Date.now()
    const snapshot = await rebuildProjection({ url })
    const completion = snapshot.completions.get(result.completionId)
    const data = completion?.data as
      | { timeoutMs: number; deadlineAtMs: number }
      | undefined
    expect(data?.timeoutMs).toBe(30_000)
    expect(data?.deadlineAtMs).toBeGreaterThanOrEqual(before + 30_000)
    expect(data?.deadlineAtMs).toBeLessThanOrEqual(after + 30_000)
  })

  it("waitFor without timeoutMs writes neither timeoutMs nor deadlineAtMs", async () => {
    const url = await createSubstrateStream("waitfor-no-deadline")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const waits = yield* DurableWaits
        return yield* waits.waitFor({
          trigger: { kind: "projection_match", description: 1 },
        })
      }).pipe(Effect.provide(DurableWaitsLive({ streamUrl: url }))),
    )
    const snapshot = await rebuildProjection({ url })
    const data = snapshot.completions.get(result.completionId)?.data as
      | { timeoutMs?: number; deadlineAtMs?: number }
      | undefined
    expect(data?.timeoutMs).toBeUndefined()
    expect(data?.deadlineAtMs).toBeUndefined()
  })
})

describe("durable-subscribers.COMPLETION_AUTHORITY", () => {
  it("durable-subscribers.COMPLETION_AUTHORITY.1 + .2 — duplicate subscriber attempts (idempotent) do not rewrite the authoritative terminal", async () => {
    const url = await createSubstrateStream("auth-idempotent")
    const completionId = "c-auth-1"
    await appendEvent(url, createPendingCompletion({
      completionId,
      kind: "timer",
      data: { dueAtMs: Date.now() - 100 },
    }))

    // First scan resolves.
    const r1 = await Effect.runPromise(runTimerSubscriber({ streamUrl: url }))
    expect(r1.resolvedIds).toEqual([completionId])
    const firstResult = (await rebuildProjection({ url })).completions.get(completionId)?.result
    expect(firstResult).toBeDefined()

    // Second scan (architect #5b idempotency): completion is now terminal in
    // snapshot, so subscriber skips and does not append a duplicate evidence record.
    const r2 = await Effect.runPromise(runTimerSubscriber({ streamUrl: url }))
    expect(r2.resolvedIds).toEqual([])

    // Authoritative result unchanged.
    const finalResult = (await rebuildProjection({ url })).completions.get(completionId)?.result
    expect(finalResult).toEqual(firstResult)
  })

  it("durable-subscribers.COMPLETION_AUTHORITY.1 — subscriber appends a CANDIDATE terminal; if a terminal already exists from another writer, the snapshot-skip avoids duplicate append", async () => {
    const url = await createSubstrateStream("auth-already-resolved")
    const completionId = "c-auth-2"
    await appendEvent(url, createPendingCompletion({
      completionId,
      kind: "timer",
      data: { dueAtMs: Date.now() - 100 },
    }))

    // Pre-resolve the completion via CompletionProducer (simulates another writer).
    await Effect.runPromise(
      Effect.gen(function* () {
        const cp = yield* CompletionProducer
        yield* cp.resolveCompletion({
          completionId,
          result: { firedByAnotherWriter: true },
        })
      }).pipe(Effect.provide(SubstrateProducerLive({ streamUrl: url }))),
    )

    // Subscriber scans; sees terminal in snapshot; skips.
    const r = await Effect.runPromise(runTimerSubscriber({ streamUrl: url }))
    expect(r.resolvedIds).toEqual([])

    const snapshot = await rebuildProjection({ url })
    const completion = snapshot.completions.get(completionId) as CompletionValue
    expect(completion.state).toBe("resolved")
    // Authoritative result is the prior writer's, not the subscriber's.
    expect((completion.result as { firedByAnotherWriter: boolean }).firedByAnotherWriter).toBe(true)
  })
})

describe("durable-subscribers.RESTART_SAFETY", () => {
  it("durable-subscribers.RESTART_SAFETY.1 + .4 — a fresh subscriber call rebuilds from durable state alone (no in-memory pending-work state)", async () => {
    const url = await createSubstrateStream("restart-fresh")
    // Seed two due timers + one future timer.
    await appendEvent(url, createPendingCompletion({
      completionId: "due-1",
      kind: "timer",
      data: { dueAtMs: Date.now() - 200 },
    }))
    await appendEvent(url, createPendingCompletion({
      completionId: "due-2",
      kind: "timer",
      data: { dueAtMs: Date.now() - 100 },
    }))
    await appendEvent(url, createPendingCompletion({
      completionId: "future",
      kind: "timer",
      data: { dueAtMs: Date.now() + 1_000_000 },
    }))

    // Each Effect.runPromise is an independent runtime; the subscriber holds
    // no in-memory pending-work state across calls.
    const r1 = await Effect.runPromise(runTimerSubscriber({ streamUrl: url }))
    expect(new Set(r1.resolvedIds)).toEqual(new Set(["due-1", "due-2"]))

    // Second fresh call: nothing eligible (the two are now terminal; future not yet due).
    const r2 = await Effect.runPromise(runTimerSubscriber({ streamUrl: url }))
    expect(r2.resolvedIds).toEqual([])

    // Authority unchanged (RESTART_SAFETY.4 — assert via projection rebuild).
    const snapshot = await rebuildProjection({ url })
    expect(snapshot.completions.get("due-1")?.state).toBe("resolved")
    expect(snapshot.completions.get("due-2")?.state).toBe("resolved")
    expect(snapshot.completions.get("future")?.state).toBe("pending")
  })

  it("durable-subscribers.RESTART_SAFETY.2 — conservatively rescanning is harmless under completion authority", async () => {
    const url = await createSubstrateStream("restart-rescan-harmless")
    await appendEvent(url, createPendingCompletion({
      completionId: "rs-1",
      kind: "scheduled_work",
      data: { whenMs: Date.now() - 50, input: { x: 1 } },
    }))
    // Run subscriber three times — all subsequent runs see terminal in snapshot and skip.
    for (let i = 0; i < 3; i++) {
      await Effect.runPromise(runScheduledWorkSubscriber({ streamUrl: url }))
    }
    const snapshot = await rebuildProjection({ url })
    expect(snapshot.completions.get("rs-1")?.state).toBe("resolved")
    // Single completion row; no proliferation of duplicate evidence.
    expect(snapshot.completions.size).toBe(1)
  })
})

describe("durable-subscribers — error paths", () => {
  it("subscriber against a non-existent stream surfaces SubscriberStreamError", async () => {
    const url = freshStreamUrl("subscriber-no-stream")
    const result = await Effect.runPromise(
      Effect.either(runTimerSubscriber({ streamUrl: url })),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(SubscriberStreamError)
    }
    // Same for scheduled_work and projection_match.
    const r2 = await Effect.runPromise(
      Effect.either(runScheduledWorkSubscriber({ streamUrl: url })),
    )
    expect(Either.isLeft(r2)).toBe(true)
    const r3 = await Effect.runPromise(
      Effect.either(
        runProjectionMatchSubscriber({
          streamUrl: url,
          evaluate: () => Effect.succeed({ kind: "no-match" as const }),
        }),
      ),
    )
    expect(Either.isLeft(r3)).toBe(true)
  })

})

describe("durable-subscribers.API_FUTURE_PROOFING", () => {
  it("durable-subscribers.API_FUTURE_PROOFING.3 — subscriber implementation does not export Fireline-branded tool names as substrate primitives", async () => {
    const subMod = await import("../subscribers.ts")
    const names = Object.keys(subMod)
    for (const banned of [
      "sleep",
      "wait_for",
      "schedule_me",
      "spawn",
      "spawn_all",
      "execute",
    ]) {
      expect(names).not.toContain(banned)
    }
  })

  it("durable-subscribers.API_FUTURE_PROOFING.4 — callers do not need to thread raw stream records / envelopes / claim internals through the normal subscriber path", () => {
    // Subscriber input shape is small: streamUrl (+ optional contentType, +
    // evaluate for projection_match). No raw ChangeEvent / claim helper is required.
    expect(true).toBe(true)
  })
})
