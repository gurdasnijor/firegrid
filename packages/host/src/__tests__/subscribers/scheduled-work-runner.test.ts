import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { SubstrateHostBoot } from "../../index.js"
import {
  freshSubstrateStream,
  seedPendingScheduledWork,
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
//
// Scheduled-work runner mirrors the timer runner but uses
// runScheduledWorkSubscriber under the hood. Resolution data
// preserves whenMs and the opaque scheduled input, matching
// durable-subscribers.SCHEDULED_WORK_SUBSCRIBER.4.
describe("launchable-substrate-host.HOST_PROCESS.3 — scheduled-work subscriber program", () => {
  it("a past-due scheduled_work seeded before the host scope opens is resolved with whenMs and opaque input preserved", async () => {
    const streamUrl = await freshSubstrateStream("sw-startup")
    const completionId = "c-sw-startup"
    const whenMs = Date.now() - 1000
    const input = { kind: "schedule", payload: "demo" }
    await seedPendingScheduledWork(streamUrl, completionId, whenMs, input)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
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
            | { whenMs: number; input: unknown }
            | undefined
          expect(r?.whenMs).toBe(whenMs)
          expect(r?.input).toEqual(input)
        }).pipe(
          Effect.provide(
            SubstrateHostBoot.attached({
              streamUrl,
              profile: { subscribers: { scheduledWork: true } },
            }),
          ),
        ),
      ),
    )
  })
})

// Per-kind independence: enabling both kinds resolves both; enabling
// only one kind leaves the other pending.
describe("launchable-substrate-host.HOST_PROCESS.3 — per-kind subscriber independence", () => {
  it("with both timer and scheduledWork enabled, both past-due completions resolve", async () => {
    const streamUrl = await freshSubstrateStream("twokinds-both")
    const idTimer = "c-twok-timer"
    const idSw = "c-twok-sw"
    await seedPendingTimer(streamUrl, idTimer, Date.now() - 500)
    await seedPendingScheduledWork(streamUrl, idSw, Date.now() - 500, { v: 1 })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const t = yield* Effect.tryPromise({
            try: () =>
              waitForCompletionState(
                streamUrl,
                idTimer,
                (c) => c?.state === "resolved",
                3000,
              ),
            catch: (cause) => cause,
          })
          const s = yield* Effect.tryPromise({
            try: () =>
              waitForCompletionState(
                streamUrl,
                idSw,
                (c) => c?.state === "resolved",
                3000,
              ),
            catch: (cause) => cause,
          })
          expect(t?.state).toBe("resolved")
          expect(s?.state).toBe("resolved")
        }).pipe(
          Effect.provide(
            SubstrateHostBoot.attached({
              streamUrl,
              profile: {
                subscribers: { timer: true, scheduledWork: true },
              },
            }),
          ),
        ),
      ),
    )
  })

  it("with only timer enabled, scheduled_work stays pending while timer resolves", async () => {
    const streamUrl = await freshSubstrateStream("twokinds-mixed")
    const idTimer = "c-mixed-timer"
    const idSw = "c-mixed-sw"
    await seedPendingTimer(streamUrl, idTimer, Date.now() - 500)
    await seedPendingScheduledWork(streamUrl, idSw, Date.now() - 500, { v: 2 })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const t = yield* Effect.tryPromise({
            try: () =>
              waitForCompletionState(
                streamUrl,
                idTimer,
                (c) => c?.state === "resolved",
                3000,
              ),
            catch: (cause) => cause,
          })
          expect(t?.state).toBe("resolved")
          // Give scheduledWork a fair chance to be (incorrectly)
          // resolved before asserting it stayed pending.
          yield* Effect.sleep("400 millis")
          const sw = yield* Effect.tryPromise({
            try: () => snapshotCompletion(streamUrl, idSw),
            catch: (cause) => cause,
          })
          expect(sw?.state).toBe("pending")
        }).pipe(
          Effect.provide(
            SubstrateHostBoot.attached({
              streamUrl,
              profile: {
                subscribers: { timer: true, scheduledWork: false },
              },
            }),
          ),
        ),
      ),
    )
  })
})
