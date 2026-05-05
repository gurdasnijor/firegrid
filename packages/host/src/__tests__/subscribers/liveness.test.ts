import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { _internalSubstrateHostBoot } from "../../host/constructors.js"
import { SubscriberLiveness } from "../../host/subscribers/liveness.js"
import {
  freshSubstrateStream,
  startTestServer,
  stopTestServer,
} from "./helpers.js"

beforeAll(async () => {
  await startTestServer()
})

afterAll(async () => {
  await stopTestServer()
})

// Package-internal liveness service. The host root index.ts
// intentionally does not re-export SubscriberLiveness; this test
// imports it from the subpath. The liveness shape is
// deliberately narrow — enabled/running/lastErrorSummary only — and
// must not drift toward becoming durable subscriber progress
// authority. The structural assertion below is the guard against
// adding counters, scan timestamps, resolved ids, cursor/progress,
// or terminalization summaries.
const ALLOWED_KEYS = new Set([
  "kind",
  "enabled",
  "running",
  "lastErrorSummary",
])

describe("subscriber liveness — package-internal, structurally narrow", () => {
  it("the liveness snapshot only carries enabled/running/lastErrorSummary per enabled kind, with no progress fields", async () => {
    const streamUrl = await freshSubstrateStream("liveness-shape")

    const snap = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const liveness = yield* SubscriberLiveness
          // Give the runner a tick so `running` may flip; the
          // structural assertion does not depend on the timing.
          yield* Effect.sleep("50 millis")
          return yield* liveness.snapshot()
        }).pipe(
          Effect.provide(
            _internalSubstrateHostBoot.attached({
              streamUrl,
              profile: {
                subscribers: { timer: true, scheduledWork: false },
              },
            }),
          ),
        ),
      ),
    )

    // Only the enabled kind appears.
    expect(snap.map((s) => s.kind)).toEqual(["timer"])

    // Structural narrowness: every entry's keys must be a subset
    // of the allowed set. This is the regression guard.
    for (const entry of snap) {
      for (const key of Object.keys(entry)) {
        expect(ALLOWED_KEYS.has(key)).toBe(true)
      }
      expect(entry.enabled).toBe(true)
      expect(typeof entry.running).toBe("boolean")
    }
  })

  it("with no subscribers enabled, the snapshot is empty (liveness does not invent kinds)", async () => {
    const streamUrl = await freshSubstrateStream("liveness-empty")

    const snap = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const liveness = yield* SubscriberLiveness
          return yield* liveness.snapshot()
        }).pipe(
          Effect.provide(
            _internalSubstrateHostBoot.attached({
              streamUrl,
              profile: {},
            }),
          ),
        ),
      ),
    )
    expect(snap).toEqual([])
  })
})
