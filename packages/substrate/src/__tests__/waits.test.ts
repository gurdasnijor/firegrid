import { DurableStream } from "@durable-streams/client"
import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as substrate from "../index.ts"
import { CompletionProducer, SubstrateProducerLive } from "../producer.ts"
import type { CompletionValue } from "../schema/rows.ts"
import { rebuildProjection } from "../stream.ts"
import {
  DurableWaits,
  DurableWaitsLive,
  globalAwakeableKey,
  workScopedAwakeableKey,
  type AwakeableResult,
  type ScheduleWorkResult,
  type SleepResult,
  type WaitForResult,
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

const runInWaits = <A, E>(
  url: string,
  program: Effect.Effect<A, E, DurableWaits>,
): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(DurableWaitsLive({ streamUrl: url }))))

describe("durable-waits-and-scheduling.SLEEP", () => {
  it("durable-waits-and-scheduling.SLEEP.1 + .5 — sleep creates a pending kind:timer completion with durationMs/dueAtMs data; no resolver fires", async () => {
    const url = await createSubstrateStream("sleep-create")
    const result = await runInWaits(
      url,
      Effect.gen(function* () {
        const waits = yield* DurableWaits
        return yield* waits.sleep({ durationMs: 1500 })
      }),
    )
    expect(result.kind).toBe("timer")
    expect(result.state).toBe("pending")

    const snapshot = await rebuildProjection({ url })
    const completion = snapshot.completions.get(result.completionId)
    expect(completion?.kind).toBe("timer")
    expect(completion?.state).toBe("pending")
    const data = completion?.data as { durationMs: number; dueAtMs: number } | undefined
    expect(data?.durationMs).toBe(1500)
    expect(typeof data?.dueAtMs).toBe("number")
    expect(data!.dueAtMs).toBeGreaterThanOrEqual(data!.durationMs)
  })

  it("durable-waits-and-scheduling.SLEEP.3 — timer firing is not a live JS callback (sleep returns immediately, no scheduled callback)", async () => {
    const url = await createSubstrateStream("sleep-no-callback")
    const start = Date.now()
    await runInWaits(
      url,
      Effect.gen(function* () {
        const waits = yield* DurableWaits
        return yield* waits.sleep({ durationMs: 60_000 }) // 60s — would block the test if we waited
      }),
    )
    const elapsed = Date.now() - start
    // The Effect resolves promptly; no JS timer was set.
    expect(elapsed).toBeLessThan(2_000)
  })
})

describe("durable-waits-and-scheduling.WAIT_FOR", () => {
  it("durable-waits-and-scheduling.WAIT_FOR.1 + .2 — waitFor creates a pending kind:projection_match completion carrying typed trigger data and timeoutMs", async () => {
    const url = await createSubstrateStream("waitfor-create")
    const result = await runInWaits(
      url,
      Effect.gen(function* () {
        const waits = yield* DurableWaits
        return yield* waits.waitFor({
          trigger: { kind: "projection_match", description: { collection: "users", id: "u-1" } },
          timeoutMs: 30_000,
        })
      }),
    )
    expect(result.kind).toBe("projection_match")
    expect(result.state).toBe("pending")

    const snapshot = await rebuildProjection({ url })
    const completion = snapshot.completions.get(result.completionId)
    expect(completion?.kind).toBe("projection_match")
    expect(completion?.state).toBe("pending")
    const data = completion?.data as
      | { trigger: { kind: string; description: unknown }; timeoutMs?: number }
      | undefined
    expect(data?.trigger.kind).toBe("projection_match")
    expect(data?.trigger.description).toEqual({ collection: "users", id: "u-1" })
    expect(data?.timeoutMs).toBe(30_000)
  })

  it("waitFor without timeoutMs omits it from the completion data", async () => {
    const url = await createSubstrateStream("waitfor-no-timeout")
    const result = await runInWaits(
      url,
      Effect.gen(function* () {
        const waits = yield* DurableWaits
        return yield* waits.waitFor({
          trigger: { kind: "projection_match", description: "anything" },
        })
      }),
    )
    const snapshot = await rebuildProjection({ url })
    const data = snapshot.completions.get(result.completionId)?.data as
      | { trigger: unknown; timeoutMs?: number }
      | undefined
    expect(data?.timeoutMs).toBeUndefined()
  })
})

describe("durable-waits-and-scheduling.SCHEDULE_WORK", () => {
  it("durable-waits-and-scheduling.SCHEDULE_WORK.1 + .6 — scheduleWork creates a pending kind:scheduled_work completion; no run is declared", async () => {
    const url = await createSubstrateStream("schedwork-create")
    const result = await runInWaits(
      url,
      Effect.gen(function* () {
        const waits = yield* DurableWaits
        return yield* waits.scheduleWork({
          whenMs: 1_000_000,
          input: { task: "compact-thread", args: [1, 2] },
          workId: "owner-run-1",
        })
      }),
    )
    expect(result.kind).toBe("scheduled_work")
    expect(result.state).toBe("pending")

    const snapshot = await rebuildProjection({ url })
    const completion = snapshot.completions.get(result.completionId)
    expect(completion?.kind).toBe("scheduled_work")
    expect(completion?.state).toBe("pending")
    expect(completion?.workId).toBe("owner-run-1")
    const data = completion?.data as { whenMs: number; input: unknown } | undefined
    expect(data?.whenMs).toBe(1_000_000)
    expect(data?.input).toEqual({ task: "compact-thread", args: [1, 2] })

    // No durable.run row was authored.
    expect(snapshot.runs.size).toBe(0)
  })

  it("durable-waits-and-scheduling.SCHEDULE_WORK.2 — substrate primitive is generic; no agent/prompt vocabulary surfaces in the row", async () => {
    const url = await createSubstrateStream("schedwork-generic")
    const result = await runInWaits(
      url,
      Effect.gen(function* () {
        const waits = yield* DurableWaits
        return yield* waits.scheduleWork({ whenMs: 0, input: "opaque-bytes" })
      }),
    )
    const snapshot = await rebuildProjection({ url })
    const completion = snapshot.completions.get(result.completionId)
    // The completion has the generic kind name — never "scheduled_prompt" or similar agent-specific.
    expect(completion?.kind).toBe("scheduled_work")
  })
})

describe("durable-waits-and-scheduling.AWAKEABLE_API", () => {
  it("durable-waits-and-scheduling.AWAKEABLE_API.4 + .6 — work-scoped awakeable uses awk:work:${workId}:${name} as both key and completionId", async () => {
    const url = await createSubstrateStream("awk-work")
    const result = await runInWaits(
      url,
      Effect.gen(function* () {
        const waits = yield* DurableWaits
        return yield* waits.awakeable({ workId: "run-w", name: "approval" })
      }),
    )
    expect(result.key).toBe("awk:work:run-w:approval")
    expect(result.completionId).toBe(result.key)
    expect(result.kind).toBe("externally_resolved_awakeable")
    expect(result.state).toBe("pending")

    const snapshot = await rebuildProjection({ url })
    expect(snapshot.completions.get(result.completionId)?.kind).toBe(
      "externally_resolved_awakeable",
    )
  })

  it("durable-waits-and-scheduling.AWAKEABLE_API.5 + .7 — global awakeable uses awk:global:${namespace}:${name} as the key", async () => {
    const url = await createSubstrateStream("awk-global")
    const result = await runInWaits(
      url,
      Effect.gen(function* () {
        const waits = yield* DurableWaits
        return yield* waits.awakeableGlobal({ namespace: "billing", name: "stripe-webhook" })
      }),
    )
    expect(result.key).toBe("awk:global:billing:stripe-webhook")
    expect(result.completionId).toBe(result.key)

    // Helper key derivation matches.
    expect(workScopedAwakeableKey("run-w", "approval")).toBe("awk:work:run-w:approval")
    expect(globalAwakeableKey("billing", "stripe-webhook")).toBe(
      "awk:global:billing:stripe-webhook",
    )
  })

  it("globalAwakeableKey rejects empty namespace", () => {
    expect(() => globalAwakeableKey("", "name")).toThrow()
  })

  it("durable-waits-and-scheduling.AWAKEABLE_API.8 — duplicate work-scoped awakeable creation is idempotent (returns existing id, no new pending row)", async () => {
    const url = await createSubstrateStream("awk-idempotent-work")
    const a = await runInWaits(
      url,
      Effect.gen(function* () {
        const waits = yield* DurableWaits
        return yield* waits.awakeable({ workId: "run-i", name: "ev" })
      }),
    )
    const b = await runInWaits(
      url,
      Effect.gen(function* () {
        const waits = yield* DurableWaits
        return yield* waits.awakeable({ workId: "run-i", name: "ev" })
      }),
    )
    expect(b.completionId).toBe(a.completionId)
    expect(b.key).toBe(a.key)

    // Only ONE completion row exists for this key.
    const snapshot = await rebuildProjection({ url })
    expect(snapshot.completions.size).toBe(1)
  })

  it("durable-waits-and-scheduling.AWAKEABLE_API.8 — duplicate global awakeable creation is idempotent", async () => {
    const url = await createSubstrateStream("awk-idempotent-global")
    const a = await runInWaits(
      url,
      Effect.gen(function* () {
        const waits = yield* DurableWaits
        return yield* waits.awakeableGlobal({ namespace: "ns", name: "n" })
      }),
    )
    const b = await runInWaits(
      url,
      Effect.gen(function* () {
        const waits = yield* DurableWaits
        return yield* waits.awakeableGlobal({ namespace: "ns", name: "n" })
      }),
    )
    expect(b.completionId).toBe(a.completionId)

    const snapshot = await rebuildProjection({ url })
    expect(snapshot.completions.size).toBe(1)
  })

  it("idempotent re-creation also returns the EXISTING state if the awakeable was already terminalized", async () => {
    const url = await createSubstrateStream("awk-idempotent-after-resolve")
    // Create once.
    const created = await runInWaits(
      url,
      Effect.gen(function* () {
        const waits = yield* DurableWaits
        return yield* waits.awakeable({ workId: "run-r", name: "ev" })
      }),
    )
    // Resolve via existing CompletionProducer.
    await Effect.runPromise(
      Effect.gen(function* () {
        const cp = yield* CompletionProducer
        yield* cp.resolveCompletion({
          completionId: created.completionId,
          result: { value: 42 },
        })
      }).pipe(Effect.provide(SubstrateProducerLive({ streamUrl: url }))),
    )
    // Re-create the same awakeable; should observe resolved state.
    const second = await runInWaits(
      url,
      Effect.gen(function* () {
        const waits = yield* DurableWaits
        return yield* waits.awakeable({ workId: "run-r", name: "ev" })
      }),
    )
    expect(second.completionId).toBe(created.completionId)
    expect(second.state).toBe("resolved")
  })
})

describe("durable-waits-and-scheduling — create + resolve lifecycle through CompletionProducer", () => {
  it("a sleep completion can be resolved through the existing CompletionProducer (no new resolution API in DurableWaits)", async () => {
    const url = await createSubstrateStream("sleep-resolve-lifecycle")
    const sleepResult: SleepResult = await runInWaits(
      url,
      Effect.gen(function* () {
        const waits = yield* DurableWaits
        return yield* waits.sleep({ durationMs: 500 })
      }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const cp = yield* CompletionProducer
        yield* cp.resolveCompletion({
          completionId: sleepResult.completionId,
          result: { firedAtMs: 1234 },
        })
      }).pipe(Effect.provide(SubstrateProducerLive({ streamUrl: url }))),
    )

    const snapshot = await rebuildProjection({ url })
    const completion = snapshot.completions.get(sleepResult.completionId)
    expect(completion?.state).toBe("resolved")
    expect(completion?.kind).toBe("timer") // kind preserved from the pending row's data path
    expect((completion?.result as { firedAtMs: number } | undefined)?.firedAtMs).toBe(1234)
  })

  it("a waitFor completion can be cancelled with terminal reason via CompletionProducer", async () => {
    const url = await createSubstrateStream("waitfor-cancel-lifecycle")
    const r: WaitForResult = await runInWaits(
      url,
      Effect.gen(function* () {
        const waits = yield* DurableWaits
        return yield* waits.waitFor({
          trigger: { kind: "projection_match", description: "x" },
          timeoutMs: 100,
        })
      }),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const cp = yield* CompletionProducer
        yield* cp.cancelCompletion({
          completionId: r.completionId,
          terminalReason: { kind: "timeout" },
        })
      }).pipe(Effect.provide(SubstrateProducerLive({ streamUrl: url }))),
    )
    const snapshot = await rebuildProjection({ url })
    const completion = snapshot.completions.get(r.completionId)
    expect(completion?.state).toBe("cancelled")
    expect(completion?.terminalReason).toEqual({ kind: "timeout" })
  })
})

describe("durable-waits-and-scheduling.PHASE_BOUNDARY (Slice 7)", () => {
  it("durable-waits-and-scheduling.PHASE_BOUNDARY.4 — wait APIs create completions and return ids; they do not block runs", async () => {
    const url = await createSubstrateStream("no-block-runs")
    const sleep = await runInWaits(
      url,
      Effect.gen(function* () {
        const waits = yield* DurableWaits
        return yield* waits.sleep({ durationMs: 1 })
      }),
    )
    const sched: ScheduleWorkResult = await runInWaits(
      url,
      Effect.gen(function* () {
        const waits = yield* DurableWaits
        return yield* waits.scheduleWork({ whenMs: 0, input: null })
      }),
    )
    const awk: AwakeableResult = await runInWaits(
      url,
      Effect.gen(function* () {
        const waits = yield* DurableWaits
        return yield* waits.awakeable({ workId: "x", name: "n" })
      }),
    )
    const wait = await runInWaits(
      url,
      Effect.gen(function* () {
        const waits = yield* DurableWaits
        return yield* waits.waitFor({
          trigger: { kind: "projection_match", description: 1 },
        })
      }),
    )

    const snapshot = await rebuildProjection({ url })
    // Four completions, zero runs.
    expect(snapshot.runs.size).toBe(0)
    expect(snapshot.completions.size).toBe(4)
    // All completions are still in "pending" state (no auto-terminalization).
    for (const id of [sleep.completionId, sched.completionId, awk.completionId, wait.completionId]) {
      expect(snapshot.completions.get(id)?.state).toBe("pending")
    }
  })

  it("durable-waits-and-scheduling.PHASE_BOUNDARY.3 — Slice 7 waits module exposes no operator/claim/runtime/CLI/timer-resolver/projection-matcher symbols", async () => {
    const waitsMod = await import("../waits.ts")
    const names = Object.keys(waitsMod)
    for (const symbol of [
      "OperatorRunner",
      "Operator",
      "Claim",
      "ClaimProducer",
      "claim",
      "runCli",
      "TimerResolver",
      "ProjectionMatcher",
      "Watcher",
      "blockRun",
      "completeRun",
      "failRun",
      "cancelRun",
    ]) {
      expect(names).not.toContain(symbol)
    }
  })

  it("DurableWaits public package surface exists; no DurableAwakeables service was added", () => {
    const m = substrate as unknown as Record<string, unknown>
    expect(typeof m.DurableWaits).toBe("function")
    expect(typeof m.DurableWaitsLive).toBe("function")
    expect(m.DurableAwakeables).toBeUndefined()
    expect(m.DurableAwakeablesLive).toBeUndefined()
  })
})
