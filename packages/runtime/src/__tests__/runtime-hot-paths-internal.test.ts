import {
  completeRunEffect,
  IllegalRunTransition,
  type CompletionValue,
} from "@firegrid/substrate/kernel"
import { Operation } from "@firegrid/substrate"
import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  Ref,
  Schema,
  TestClock,
  TestContext,
} from "effect"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  AcquireDbError as RunnerAcquireDbError,
  minPendingDueAtMs,
  subscribeCompletionsAndEventStreams,
  runScopedSubscriberLoopWithAcquire,
  runScopedSubscriberLoopFromDb,
} from "../internal/runner.ts"
import {
  AcquireDbError as HandlerAcquireDbError,
  runOperationDispatchLoopWithAcquire,
} from "../internal/operation-handler.ts"

type FakeSubscription = { readonly unsubscribe: () => void }
type FakeCollection<T> = {
  readonly state: Map<string, T>
  subscribeChanges: (cb: () => void) => FakeSubscription
}

const fakeCollection = <T>(): FakeCollection<T> => ({
  state: new Map<string, T>(),
  subscribeChanges: () => ({ unsubscribe: () => undefined }),
})

const fakeDb = () =>
  ({
    collections: {
      runs: fakeCollection(),
      completions: fakeCollection<CompletionValue>(),
      claimAttempts: fakeCollection(),
      eventStreams: fakeCollection(),
    },
    close: () => undefined,
  }) as never

// firegrid-runtime-process.RUNTIME_RUN_API.10
// Architectural-constraint source helper: behavior tests in this file
// exercise coalescing, deadlines, teardown, and typed failures directly.
// Remaining source reads are reserved for negative constraints against
// reintroducing known unmanaged loop / whole-projection rebuild shapes.
const runtimeSource = (relative: string) =>
  readFileSync(
    fileURLToPath(new URL(`../internal/${relative}`, import.meta.url)),
    "utf8",
  )

const executableSource = (relative: string) =>
  runtimeSource(relative)
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/^\s*\/\/.*$/gm, "")

describe("firegrid-remediation-hardening.TEST_GUARDRAILS.3 — runtime runner internals", () => {
  it("firegrid-remediation-hardening.TEST_GUARDRAILS.3 — minPendingDueAtMs selects the earliest pending due time and ignores terminal/missing values", () => {
    const completions = new Map<string, CompletionValue>([
      [
        "resolved",
        {
          completionId: "resolved",
          kind: "timer",
          state: "resolved",
          result: {},
          data: { dueAtMs: 1 },
        },
      ],
      [
        "missing",
        {
          completionId: "missing",
          kind: "timer",
          state: "pending",
          data: {},
        },
      ],
      [
        "later",
        {
          completionId: "later",
          kind: "timer",
          state: "pending",
          data: { dueAtMs: 50 },
        },
      ],
      [
        "earlier",
        {
          completionId: "earlier",
          kind: "timer",
          state: "pending",
          data: { dueAtMs: 25 },
        },
      ],
    ])

    const due = minPendingDueAtMs(completions, (completion) => {
      const data = completion.data as { readonly dueAtMs?: unknown } | undefined
      return typeof data?.dueAtMs === "number" ? data.dueAtMs : undefined
    })

    expect(due).toBe(25)
  })

  it("firegrid-remediation-hardening.EFFECT_CONSISTENCY.3, firegrid-remediation-hardening.HOT_PATHS.1 — subscriber wakes coalesce without latch/forever/race loops and unsubscribe on scope teardown", async () => {
    const db = fakeDb()
    let wake: (() => void) | undefined
    let unsubscribed = false
    ;(db as {
      collections: {
        completions: FakeCollection<CompletionValue>
      }
    }).collections.completions.subscribeChanges = (cb) => {
      wake = cb
      return {
        unsubscribe: () => {
          unsubscribed = true
        },
      }
    }

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scans = yield* Ref.make(0)
          const firstScanStarted = yield* Deferred.make<void>()
          const releaseFirstScan = yield* Deferred.make<void>()
          const secondScanFinished = yield* Deferred.make<void>()

          const fiber = yield* Effect.fork(
            runScopedSubscriberLoopFromDb(db, {
              subscribe: (database, onEdge) =>
                (database as {
                  collections: {
                    completions: FakeCollection<CompletionValue>
                  }
                }).collections.completions.subscribeChanges(onEdge)
                  .unsubscribe,
              nextDeadlineMs: () => undefined,
              scan: () =>
                Effect.gen(function* () {
                  const count = yield* Ref.updateAndGet(scans, (n) => n + 1)
                  if (count === 1) {
                    yield* Deferred.succeed(firstScanStarted, undefined)
                    yield* Deferred.await(releaseFirstScan)
                    return
                  }
                  if (count === 2) {
                    yield* Deferred.succeed(secondScanFinished, undefined)
                  }
                }),
            }),
          )

          yield* Deferred.await(firstScanStarted)
          wake?.()
          wake?.()
          yield* Deferred.succeed(releaseFirstScan, undefined)
          yield* Deferred.await(secondScanFinished)
          yield* TestClock.adjust(Duration.millis(20))
          const count = yield* Ref.get(scans)
          yield* Fiber.interrupt(fiber)
          return count
        }),
      ).pipe(Effect.provide(TestContext.TestContext)),
    )

    expect(observed).toBe(2)
    expect(unsubscribed).toBe(true)
  })

  it("firegrid-remediation-hardening.TEST_GUARDRAILS.3 — runner deadline stream wakes the subscriber when the next due time arrives", async () => {
    const db = fakeDb()
    let scans = 0

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const secondScanFinished = yield* Deferred.make<void>()

          const fiber = yield* Effect.fork(
            runScopedSubscriberLoopFromDb(db, {
              subscribe: () => () => undefined,
              nextDeadlineMs: () =>
                scans === 1 ? Date.now() + 20 : undefined,
              scan: () =>
                Effect.gen(function* () {
                  scans += 1
                  if (scans === 2) {
                    yield* Deferred.succeed(secondScanFinished, undefined)
                  }
                }),
            }),
          )

          yield* Deferred.await(secondScanFinished)
          yield* Effect.sleep("40 millis")
          yield* Fiber.interrupt(fiber)
          return scans
        }),
      ),
    )

    expect(observed).toBe(2)
  })

  it("firegrid-runtime-process.RUNTIME_HOT_PATH.3 — projection-match subscription wakes on completion and EventStream edges and unsubscribes both", () => {
    const db = fakeDb()
    const callbacks: Array<() => void> = []
    const unsubscribed: string[] = []
    ;(db as {
      collections: {
        completions: FakeCollection<CompletionValue>
        eventStreams: FakeCollection<unknown>
      }
    }).collections.completions.subscribeChanges = (cb) => {
      callbacks.push(cb)
      return { unsubscribe: () => unsubscribed.push("completions") }
    }
    ;(db as {
      collections: {
        completions: FakeCollection<CompletionValue>
        eventStreams: FakeCollection<unknown>
      }
    }).collections.eventStreams.subscribeChanges = (cb) => {
      callbacks.push(cb)
      return { unsubscribe: () => unsubscribed.push("eventStreams") }
    }

    let wakes = 0
    const unsubscribe = subscribeCompletionsAndEventStreams(db, () => {
      wakes += 1
    })
    expect(callbacks).toHaveLength(2)
    callbacks[0]?.()
    callbacks[1]?.()
    expect(wakes).toBe(2)

    unsubscribe()
    expect(new Set(unsubscribed)).toEqual(
      new Set(["completions", "eventStreams"]),
    )
  })

  it("firegrid-runtime-process.RUNTIME_HOT_PATH.3 — projection-match deadlines can reuse minPendingDueAtMs", () => {
    const completions = new Map<string, CompletionValue>([
      [
        "other-kind",
        {
          completionId: "other-kind",
          kind: "timer",
          state: "pending",
          data: { deadlineAtMs: 1 },
        },
      ],
      [
        "terminal",
        {
          completionId: "terminal",
          kind: "projection_match",
          state: "cancelled",
          data: { deadlineAtMs: 5 },
        },
      ],
      [
        "later",
        {
          completionId: "later",
          kind: "projection_match",
          state: "pending",
          data: { deadlineAtMs: 50 },
        },
      ],
      [
        "earlier",
        {
          completionId: "earlier",
          kind: "projection_match",
          state: "pending",
          data: { deadlineAtMs: 25 },
        },
      ],
    ])

    const due = minPendingDueAtMs(completions, (completion) => {
      if (completion.kind !== "projection_match") return undefined
      const data = completion.data as
        | { readonly deadlineAtMs?: unknown }
        | undefined
      return typeof data?.deadlineAtMs === "number"
        ? data.deadlineAtMs
        : undefined
    })

    expect(due).toBe(25)
  })

  it("firegrid-remediation-hardening.TEST_GUARDRAILS.3 — runner deadline stream cancels a stale pending deadline after an edge wake recomputes no due time", async () => {
    const db = fakeDb()
    let wake: (() => void) | undefined
    let scans = 0
    ;(db as {
      collections: {
        completions: FakeCollection<CompletionValue>
      }
    }).collections.completions.subscribeChanges = (cb) => {
      wake = cb
      return { unsubscribe: () => undefined }
    }

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const firstScanFinished = yield* Deferred.make<void>()
          const secondScanFinished = yield* Deferred.make<void>()

          const fiber = yield* Effect.fork(
            runScopedSubscriberLoopFromDb(db, {
              subscribe: (database, onEdge) =>
                (database as {
                  collections: {
                    completions: FakeCollection<CompletionValue>
                  }
                }).collections.completions.subscribeChanges(onEdge)
                  .unsubscribe,
              nextDeadlineMs: () =>
                scans === 1 ? Date.now() + 80 : undefined,
              scan: () =>
                Effect.gen(function* () {
                  scans += 1
                  if (scans === 1) {
                    yield* Deferred.succeed(firstScanFinished, undefined)
                  }
                  if (scans === 2) {
                    yield* Deferred.succeed(secondScanFinished, undefined)
                  }
                }),
            }),
          )

          yield* Deferred.await(firstScanFinished)
          wake?.()
          yield* Deferred.await(secondScanFinished)
          yield* Effect.sleep("120 millis")
          yield* Fiber.interrupt(fiber)
          return scans
        }),
      ),
    )

    expect(observed).toBe(2)
  })

  it("firegrid-remediation-hardening.TEST_GUARDRAILS.3 — runner database acquisition failures stay tagged", async () => {
    const exit = await Effect.runPromiseExit(
      runScopedSubscriberLoopWithAcquire(
        Effect.fail(new RunnerAcquireDbError({ cause: "boom" })),
        {
          subscribe: () => () => undefined,
          nextDeadlineMs: () => undefined,
          scan: () => Effect.void,
        },
      ),
    )

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const failure = exit.cause._tag === "Fail" ? exit.cause.error : undefined
      expect((failure as { readonly _tag?: string } | undefined)?._tag).toBe(
        "AcquireDbError",
      )
    }
  })
})

describe("firegrid-remediation-hardening.EFFECT_CONSISTENCY — runtime source guardrails", () => {
  it("firegrid-runtime-process.RUNTIME_RUN_API.10, firegrid-remediation-hardening.EFFECT_CONSISTENCY.3, firegrid-runtime-process.RUNTIME_HOT_PATH.1 — architectural constraint forbids ad hoc latch loops and whole-projection rebuilds", () => {
    // firegrid-runtime-process.RUNTIME_RUN_API.10
    // Architectural-constraint source check: the behavior tests above
    // exercise the subscriber loop; this grep is retained only to block
    // known negative patterns that are cheap one-off architectural guards.
    const runnerSource = executableSource("runner.ts")
    expect(runnerSource).not.toContain("deadlineFiber")
    expect(runnerSource).not.toContain("Fiber.interrupt")

    const operationHandlerSource = executableSource("operation-handler.ts")
    for (const source of [runnerSource, operationHandlerSource]) {
      expect(source).not.toContain("Effect.makeLatch")
      expect(source).not.toContain("Effect.forever")
      expect(source).not.toContain("Effect.race(")
      expect(source).not.toContain("rebuildProjection")
    }
  })

  it("firegrid-remediation-hardening.CODE_REUSE.2, firegrid-remediation-hardening.EFFECT_CONSISTENCY.4 — operation handler uses Effect-returning run-event builders", async () => {
    const exit = await Effect.runPromiseExit(
      completeRunEffect(
        { runId: "already-completed", state: "completed", result: {} },
        { result: {} },
      ),
    )

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const failure = exit.cause._tag === "Fail" ? exit.cause.error : undefined
      expect(failure).toBeInstanceOf(IllegalRunTransition)
      expect(failure?._tag).toBe("IllegalRunTransition")
    }

    // firegrid-runtime-process.RUNTIME_RUN_API.10
    // Architectural-constraint source check: the positive builder behavior
    // is asserted above via completeRunEffect; this negative grep prevents
    // reintroducing the prior untyped catch-all error mapping shape.
    expect(runtimeSource("operation-handler.ts")).not.toContain(
      "catch: (cause) => cause",
    )
  })

  it("firegrid-remediation-hardening.TEST_GUARDRAILS.3 — operation handler database acquisition failures stay tagged", async () => {
    const op = Operation.define({
      name: "AcquireFailureOp",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
    })

    const exit = await Effect.runPromiseExit(
      runOperationDispatchLoopWithAcquire(
        {
          streamUrl: "http://127.0.0.1:1/substrate/unused",
          contentType: "application/json",
          processId: "test",
          streamIdentity: {
            streamUrl: "http://127.0.0.1:1/substrate/unused",
            streamName: "unused",
            host: "127.0.0.1",
            port: 1,
          },
        },
        { op, run: () => Effect.succeed({}) },
        Effect.fail(new HandlerAcquireDbError({ cause: "boom" })),
      ),
    )

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const failure = exit.cause._tag === "Fail" ? exit.cause.error : undefined
      expect((failure as { readonly _tag?: string } | undefined)?._tag).toBe(
        "AcquireDbError",
      )
    }
  })
})
