import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { SubstrateHostBoot } from "../../index.js"
import {
  freshSubstrateStream,
  seedPendingTimer,
  snapshotCompletion,
  startTestServer,
  stopTestServer,
  waitForCompletionState,
} from "./helpers.js"

beforeAll(async () => {
  await startTestServer()
})

afterAll(async () => {
  await stopTestServer()
})

// launchable-substrate-host.HOST_PROCESS.3
// launchable-substrate-host.HOST_PROCESS.3-note
// effect-native-api.EFFECT_SERVICES.9
//
// Startup catch-up: a past-due timer seeded BEFORE the host scope
// opens is resolved by the runner without any fixed-cadence wait.
// Proves the scoped Effect program plus startup catch-up scan; rules
// out a polling timer entirely (the only reason the runner runs at
// all here is the explicit scan after preload).
describe("launchable-substrate-host.HOST_PROCESS.3 — timer subscriber program (startup catch-up)", () => {
  it("a past-due timer seeded before the host scope opens is resolved by the runner", async () => {
    const streamUrl = await freshSubstrateStream("timer-startup")
    const completionId = "c-timer-startup"
    const dueAtMs = Date.now() - 1000
    await seedPendingTimer(streamUrl, completionId, dueAtMs)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // Wait outside the test's wall clock — the runner forks at
          // layer construction, runs its startup catch-up, and the
          // resolved row appears in the durable fold.
          const completion = yield* Effect.tryPromise({
            try: () =>
              waitForCompletionState(
                streamUrl,
                completionId,
                (c) => c?.state === "resolved",
                3000,
              ),
            catch: (cause) => cause,
          })
          expect(completion?.state).toBe("resolved")
          const r = completion?.result as
            | { dueAtMs: number; observedFireMs: number }
            | undefined
          expect(r?.dueAtMs).toBe(dueAtMs)
          expect(r?.observedFireMs).toBeGreaterThanOrEqual(dueAtMs)
        }).pipe(
          Effect.provide(
            SubstrateHostBoot.attached({
              streamUrl,
              profile: { subscribers: { timer: true } },
            }),
          ),
        ),
      ),
    )
  })
})

// launchable-substrate-host.HOST_PROCESS.3-note (durable subscription edge wake)
//
// Mid-flight wake: with no pending due-time at startup, the runner
// has no deadline to sleep on. It is woken solely by the
// `subscribeChanges` edge when a fresh past-due timer is appended
// during the scope. This test would FAIL under a polling design that
// relies on a deadline being set up front.
describe("launchable-substrate-host.HOST_PROCESS.3 — subscription-edge wake", () => {
  it("a past-due timer appended mid-scope is resolved without a startup deadline", async () => {
    const streamUrl = await freshSubstrateStream("timer-edge")
    const completionId = "c-timer-edge"

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // Give the runner a moment to settle into its
          // edge-only wait state (no due-time exists yet).
          yield* Effect.sleep("100 millis")

          yield* Effect.tryPromise({
            try: () => seedPendingTimer(streamUrl, completionId, Date.now() - 1),
            catch: (cause) => cause,
          })

          const completion = yield* Effect.tryPromise({
            try: () =>
              waitForCompletionState(
                streamUrl,
                completionId,
                (c) => c?.state === "resolved",
                3000,
              ),
            catch: (cause) => cause,
          })
          expect(completion?.state).toBe("resolved")
        }).pipe(
          Effect.provide(
            SubstrateHostBoot.attached({
              streamUrl,
              profile: { subscribers: { timer: true } },
            }),
          ),
        ),
      ),
    )
  })
})

// launchable-substrate-host.HOST_PROCESS.3-note (next-due-time deadline wake)
//
// A future timer is NOT resolved before its due time, then IS
// resolved promptly after. Generous timing windows; if the bound
// becomes flaky the runner deadline math is wrong and we should stop
// rather than weaken the assertion.
describe("launchable-substrate-host.HOST_PROCESS.3 — due-time deadline wake", () => {
  it("a future timer stays pending before its dueAtMs and resolves shortly after", async () => {
    const streamUrl = await freshSubstrateStream("timer-deadline")
    const completionId = "c-timer-deadline"
    const dueAtMs = Date.now() + 800

    await seedPendingTimer(streamUrl, completionId, dueAtMs)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // Snapshot at 300ms — should still be pending.
          yield* Effect.sleep("300 millis")
          const earlySnap = yield* Effect.tryPromise({
            try: () => snapshotCompletion(streamUrl, completionId),
            catch: (cause) => cause,
          })
          expect(earlySnap?.state).toBe("pending")

          // Wait until well after the deadline.
          const completion = yield* Effect.tryPromise({
            try: () =>
              waitForCompletionState(
                streamUrl,
                completionId,
                (c) => c?.state === "resolved",
                3000,
              ),
            catch: (cause) => cause,
          })
          expect(completion?.state).toBe("resolved")
        }).pipe(
          Effect.provide(
            SubstrateHostBoot.attached({
              streamUrl,
              profile: { subscribers: { timer: true } },
            }),
          ),
        ),
      ),
    )
  })
})

// Profile gating: timer disabled means the runner does not fork.
// A past-due timer remains pending across a 500ms window.
describe("launchable-substrate-host.RUNTIME_COMPOSITION.1 — disabled subscriber stays pending", () => {
  it("with timer:false in the profile, a past-due timer is not resolved by the host", async () => {
    const streamUrl = await freshSubstrateStream("timer-disabled")
    const completionId = "c-timer-disabled"
    await seedPendingTimer(streamUrl, completionId, Date.now() - 1000)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.sleep("500 millis")
          const completion = yield* Effect.tryPromise({
            try: () => snapshotCompletion(streamUrl, completionId),
            catch: (cause) => cause,
          })
          expect(completion?.state).toBe("pending")
        }).pipe(
          Effect.provide(
            SubstrateHostBoot.attached({
              streamUrl,
              profile: { subscribers: { timer: false } },
            }),
          ),
        ),
      ),
    )
  })
})

// durable-subscribers.RESTART_SAFETY.1
//
// A fresh runner rebuilds entirely from durable state — no in-memory
// pending-work hand-off across host-scope boundaries. We seed work in
// scope A, watch it resolve, end scope A, seed NEW work, open scope
// B against the same stream URL, and the new work also resolves.
describe("durable-subscribers.RESTART_SAFETY.1 — restart from durable state alone", () => {
  it("a second host scope on the same stream resolves new pending timers without inheriting in-memory state", async () => {
    const streamUrl = await freshSubstrateStream("timer-restart")

    // Scope A
    const idA = "c-timer-restart-a"
    await seedPendingTimer(streamUrl, idA, Date.now() - 500)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () =>
              waitForCompletionState(
                streamUrl,
                idA,
                (c) => c?.state === "resolved",
                3000,
              ),
            catch: (cause) => cause,
          })
        }).pipe(
          Effect.provide(
            SubstrateHostBoot.attached({
              streamUrl,
              profile: { subscribers: { timer: true } },
            }),
          ),
        ),
      ),
    )

    // Scope A closed; seed NEW pending work and open Scope B.
    const idB = "c-timer-restart-b"
    await seedPendingTimer(streamUrl, idB, Date.now() - 500)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const c = yield* Effect.tryPromise({
            try: () =>
              waitForCompletionState(
                streamUrl,
                idB,
                (c) => c?.state === "resolved",
                3000,
              ),
            catch: (cause) => cause,
          })
          expect(c?.state).toBe("resolved")
        }).pipe(
          Effect.provide(
            SubstrateHostBoot.attached({
              streamUrl,
              profile: { subscribers: { timer: true } },
            }),
          ),
        ),
      ),
    )
  })
})

// launchable-substrate-host.AUTHORITY_BOUNDARY.2
//
// Two concurrent host scopes attached to the same substrate stream.
// Both runners scan and may both append a candidate terminal record;
// the durable fold authority remains singular — there is exactly one
// authoritative resolved terminal in the projection. Raw duplicate
// attempts are acceptable per first-valid-terminal completion
// authority. The host never becomes a second authority.
describe("launchable-substrate-host.AUTHORITY_BOUNDARY.2 — two concurrent hosts preserve completion authority", () => {
  it("two host scopes on the same stream produce exactly one authoritative resolved terminal in the durable fold", async () => {
    const streamUrl = await freshSubstrateStream("timer-twohosts")
    const completionId = "c-timer-twohosts"
    const dueAtMs = Date.now() - 500
    await seedPendingTimer(streamUrl, completionId, dueAtMs)

    const programA = Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () =>
            waitForCompletionState(
              streamUrl,
              completionId,
              (c) => c?.state === "resolved",
              3000,
            ),
          catch: (cause) => cause,
        })
      }).pipe(
        Effect.provide(
          SubstrateHostBoot.attached({
            streamUrl,
            profile: { subscribers: { timer: true } },
          }),
        ),
      ),
    )
    const programB = Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () =>
            waitForCompletionState(
              streamUrl,
              completionId,
              (c) => c?.state === "resolved",
              3000,
            ),
          catch: (cause) => cause,
        })
      }).pipe(
        Effect.provide(
          SubstrateHostBoot.attached({
            streamUrl,
            profile: { subscribers: { timer: true } },
          }),
        ),
      ),
    )

    await Effect.runPromise(Effect.all([programA, programB], { concurrency: 2 }))

    // Authoritative durable fold: exactly one terminal state for
    // this completion id. Raw duplicate append attempts are
    // permitted by the durable-subscribers completion-authority
    // rules; the fold result is singular regardless.
    const completion = await snapshotCompletion(streamUrl, completionId)
    expect(completion?.state).toBe("resolved")
    const r = completion?.result as
      | { dueAtMs: number; observedFireMs: number }
      | undefined
    expect(r?.dueAtMs).toBe(dueAtMs)
  })
})

// Layer-scoped finalization: a runner with no pending data sleeps
// indefinitely on its subscription edge. Closing the scope must
// interrupt the runner cleanly and allow runPromise to resolve. A
// regression where the runner held the scope open would hang this
// test until vitest's wall-clock timeout fires.
describe("effect-native-api.EFFECT_SERVICES.9 — layer-scoped finalization stops runners", () => {
  it("ending the host scope while runners are idle resolves cleanly", async () => {
    const streamUrl = await freshSubstrateStream("timer-finalize")

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // Runner is parked on latch.await with no due-time and no
          // pending completions. Closing the scope must interrupt
          // the fork cleanly; if the runner held the scope open
          // this test would hang until the vitest timeout.
          yield* Effect.sleep("150 millis")
        }).pipe(
          Effect.provide(
            SubstrateHostBoot.attached({
              streamUrl,
              profile: { subscribers: { timer: true } },
            }),
          ),
        ),
      ),
    )
    // runPromise resolved → scope finalization succeeded.
  })
})
