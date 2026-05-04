import { describe, expect, it } from "vitest"
import type { CompletionValue, RunValue } from "../rows.js"
import * as substrate from "../index.js"
import {
  blockRun,
  cancelCompletion,
  cancelRun,
  completeRun,
  createPendingCompletion,
  deriveBlockedRunOutcome,
  failRun,
  foldCompletionRecords,
  foldRunRecords,
  IllegalCompletionTransition,
  IllegalRunTransition,
  isLegalCompletionTransition,
  isLegalRunTransition,
  isTerminalCompletion,
  isTerminalRun,
  rejectCompletion,
  resolveCompletion,
  startRun,
} from "../state-machine.js"

const pendingValue = (
  e: ReturnType<typeof createPendingCompletion>,
): CompletionValue => e.value as CompletionValue

const runValueOf = (
  e: ReturnType<typeof startRun>,
): RunValue => e.value as RunValue

describe("awakeables-and-runs.COMPLETION_TRANSITIONS", () => {
  it("awakeables-and-runs.COMPLETION_TRANSITIONS.1 — absent may transition to pending", () => {
    expect(isLegalCompletionTransition(undefined, "pending")).toBe(true)
    const event = createPendingCompletion({ completionId: "c-1", kind: "timer" })
    expect(event.value).toMatchObject({ completionId: "c-1", state: "pending" })
  })

  it("awakeables-and-runs.COMPLETION_TRANSITIONS.2 — pending may transition to resolved/rejected/cancelled", () => {
    expect(isLegalCompletionTransition("pending", "resolved")).toBe(true)
    expect(isLegalCompletionTransition("pending", "rejected")).toBe(true)
    expect(isLegalCompletionTransition("pending", "cancelled")).toBe(true)
    const pending = pendingValue(createPendingCompletion({ completionId: "c-2", kind: "timer" }))
    expect(resolveCompletion(pending, { result: 1 }).value).toMatchObject({ state: "resolved" })
    expect(rejectCompletion(pending, { error: "x" }).value).toMatchObject({ state: "rejected" })
    expect(cancelCompletion(pending, { terminalReason: "x" }).value).toMatchObject({ state: "cancelled" })
  })

  it("awakeables-and-runs.COMPLETION_TRANSITIONS.3 — resolved/rejected/cancelled are terminal", () => {
    expect(isTerminalCompletion("resolved")).toBe(true)
    expect(isTerminalCompletion("rejected")).toBe(true)
    expect(isTerminalCompletion("cancelled")).toBe(true)
    expect(isTerminalCompletion("pending")).toBe(false)
  })

  it("awakeables-and-runs.COMPLETION_TRANSITIONS.4 — terminal completions cannot transition again", () => {
    const pending = pendingValue(createPendingCompletion({ completionId: "c-4", kind: "timer" }))
    const resolved = resolveCompletion(pending, { result: "ok" }).value as CompletionValue
    // Single-actor re-terminalization is rejected at construction time.
    expect(() => resolveCompletion(resolved, { result: "again" })).toThrow(
      IllegalCompletionTransition,
    )
    expect(() => rejectCompletion(resolved, { error: "x" })).toThrow(IllegalCompletionTransition)
    expect(() => cancelCompletion(resolved, { terminalReason: "x" })).toThrow(
      IllegalCompletionTransition,
    )
    expect(isLegalCompletionTransition("resolved", "pending")).toBe(false)
    expect(isLegalCompletionTransition("resolved", "rejected")).toBe(false)
  })

  it("awakeables-and-runs.COMPLETION_TRANSITIONS.5 — competing terminal records: first-valid-terminal-wins", () => {
    // Two competing actors each see pending and each construct a terminal event.
    const pending = pendingValue(createPendingCompletion({ completionId: "c-5", kind: "timer" }))
    const fromActorA = resolveCompletion(pending, { result: "A" }).value as CompletionValue
    const fromActorB = rejectCompletion(pending, { error: "B" }).value as CompletionValue
    // Stream order [pending, A, B] -> A wins; B is later evidence.
    const winner = foldCompletionRecords("c-5", [pending, fromActorA, fromActorB])
    expect(winner?.state).toBe("resolved")
    expect(winner?.result).toBe("A")
  })

  it("awakeables-and-runs.COMPLETION_TRANSITIONS.6 — later conflicting terminals remain as evidence (input is not mutated)", () => {
    const pending = pendingValue(createPendingCompletion({ completionId: "c-6", kind: "timer" }))
    const a = resolveCompletion(pending, { result: "A" }).value as CompletionValue
    const b = rejectCompletion(pending, { error: "B" }).value as CompletionValue
    const records = [pending, a, b]
    foldCompletionRecords("c-6", records)
    // The input list still contains the losing terminal record as evidence.
    expect(records).toContain(b)
    expect(records).toHaveLength(3)
  })

  it("foldCompletionRecords — records for other completionIds cannot affect the target winner", () => {
    // Mixed-id input: target c-target stays pending; c-noise terminalizes.
    // The target winner must remain pending — c-noise records must be filtered out.
    const target = pendingValue(createPendingCompletion({ completionId: "c-target", kind: "timer" }))
    const noisePending = pendingValue(createPendingCompletion({ completionId: "c-noise", kind: "timer" }))
    const noiseResolved = resolveCompletion(noisePending, { result: "noise" })
      .value as CompletionValue
    const noiseRejected = rejectCompletion(noisePending, { error: "noise-2" })
      .value as CompletionValue
    const winner = foldCompletionRecords("c-target", [
      noisePending,
      target,
      noiseResolved,
      noiseRejected,
    ])
    expect(winner?.completionId).toBe("c-target")
    expect(winner?.state).toBe("pending")
  })

  it("foldCompletionRecords — empty input and target with no matching records both return undefined", () => {
    expect(foldCompletionRecords("c-x", [])).toBeUndefined()
    const other = pendingValue(createPendingCompletion({ completionId: "c-other", kind: "timer" }))
    expect(foldCompletionRecords("c-missing", [other])).toBeUndefined()
  })
})

describe("awakeables-and-runs.AWAKEABLE", () => {
  it("awakeables-and-runs.AWAKEABLE.1 — durable.completion is the internal promise/deferred state machine", () => {
    // Structural: the state machine module operates on durable.completion only.
    const event = createPendingCompletion({ completionId: "c-1", kind: "timer" })
    expect(event.type).toBe("durable.completion")
  })

  it("awakeables-and-runs.AWAKEABLE.2 — a completion can be pending", () => {
    const event = createPendingCompletion({ completionId: "c-2", kind: "timer" })
    expect((event.value as CompletionValue).state).toBe("pending")
  })

  it("awakeables-and-runs.AWAKEABLE.3 — a pending completion can resolve with durable result data", () => {
    const pending = pendingValue(createPendingCompletion({ completionId: "c-3", kind: "timer" }))
    const resolved = resolveCompletion(pending, { result: { hello: "world" } })
      .value as CompletionValue
    expect(resolved.state).toBe("resolved")
    expect(resolved.result).toEqual({ hello: "world" })
  })

  it("awakeables-and-runs.AWAKEABLE.4 — a pending completion can reject with durable error data", () => {
    const pending = pendingValue(createPendingCompletion({ completionId: "c-4", kind: "timer" }))
    const rejected = rejectCompletion(pending, { error: { code: "E_BOOM" } })
      .value as CompletionValue
    expect(rejected.state).toBe("rejected")
    expect(rejected.error).toEqual({ code: "E_BOOM" })
  })

  it("awakeables-and-runs.AWAKEABLE.5 — resolution does not resume a live JS callback as truth", () => {
    // Structural: the state machine module exposes pure functions and rows.
    // It does not register, dispatch to, or accept any callback parameter.
    for (const fn of [
      createPendingCompletion,
      resolveCompletion,
      rejectCompletion,
      cancelCompletion,
    ]) {
      expect(typeof fn).toBe("function")
    }
    // No subscription/callback API exists for completions.
    expect((substrate as unknown as Record<string, unknown>).onCompletionResolved).toBeUndefined()
    expect((substrate as unknown as Record<string, unknown>).subscribeCompletion).toBeUndefined()
  })

  it("awakeables-and-runs.AWAKEABLE.6 — resolution is observed through rebuilt durable state", () => {
    // Replay-based observation: applying the resolve fold over rebuilt records yields the resolved value.
    const pending = pendingValue(createPendingCompletion({ completionId: "c-6", kind: "timer" }))
    const resolvedRow = resolveCompletion(pending, { result: 42 }).value as CompletionValue
    const observed = foldCompletionRecords("c-6", [pending, resolvedRow])
    expect(observed?.state).toBe("resolved")
    expect(observed?.result).toBe(42)
  })

  it("awakeables-and-runs.AWAKEABLE.7 — public awakeable API is deferred from this feature; backing durable.completion state machine only", async () => {
    // Scope: this feature (state-machine.ts) does not ship a callable
    // awakeable API. Slice 7 legitimately adds DurableWaits to the broader
    // package; the deferral is per-feature, not package-wide.
    const sm = await import("../state-machine.js")
    const smNames = Object.keys(sm)
    for (const symbol of ["awakeable", "DurableWaits", "DurableAwakeables"]) {
      expect(smNames).not.toContain(symbol)
    }
    // State machine continues to operate on durable.completion only.
    const event = createPendingCompletion({ completionId: "c-7", kind: "externally_resolved_awakeable" })
    expect(event.type).toBe("durable.completion")
  })

  it("awakeables-and-runs.AWAKEABLE.8 — awakeable key construction is deferred from this feature (no key utility APIs in state-machine.ts)", async () => {
    const sm = await import("../state-machine.js")
    const smNames = Object.keys(sm)
    for (const symbol of ["workScopedAwakeableKey", "awakeableKey"]) {
      expect(smNames).not.toContain(symbol)
    }
  })

  it("awakeables-and-runs.AWAKEABLE.9 — global awakeable namespace rules are deferred from this feature (no global key API in state-machine.ts)", async () => {
    const sm = await import("../state-machine.js")
    const smNames = Object.keys(sm)
    expect(smNames).not.toContain("globalAwakeableKey")
  })

  it("awakeables-and-runs.AWAKEABLE.10 — duplicate awakeable resolutions follow first-valid-terminal-wins", () => {
    const pending = pendingValue(createPendingCompletion({
      completionId: "c-10",
      kind: "externally_resolved_awakeable",
    }))
    const first = resolveCompletion(pending, { result: "first" }).value as CompletionValue
    const dup = rejectCompletion(pending, { error: "late-conflict" }).value as CompletionValue
    const winner = foldCompletionRecords("c-10", [pending, first, dup])
    expect(winner?.state).toBe("resolved")
    expect(winner?.result).toBe("first")
  })

  it("awakeables-and-runs.AWAKEABLE.11 — a pending completion can cancel with durable terminal reason data", () => {
    const pending = pendingValue(createPendingCompletion({ completionId: "c-11", kind: "timer" }))
    const cancelled = cancelCompletion(pending, { terminalReason: { reason: "user-cancel" } })
      .value as CompletionValue
    expect(cancelled.state).toBe("cancelled")
    expect(cancelled.terminalReason).toEqual({ reason: "user-cancel" })
  })
})

describe("awakeables-and-runs.RUN_TRANSITIONS", () => {
  it("awakeables-and-runs.RUN_TRANSITIONS.1 — absent may transition to started", () => {
    expect(isLegalRunTransition(undefined, "started")).toBe(true)
    expect(isLegalRunTransition(undefined, "blocked")).toBe(false)
    expect(isLegalRunTransition(undefined, "completed")).toBe(false)
  })

  it("awakeables-and-runs.RUN_TRANSITIONS.2 — started may transition to blocked, completed, failed, or cancelled", () => {
    expect(isLegalRunTransition("started", "blocked")).toBe(true)
    expect(isLegalRunTransition("started", "completed")).toBe(true)
    expect(isLegalRunTransition("started", "failed")).toBe(true)
    expect(isLegalRunTransition("started", "cancelled")).toBe(true)
    expect(isLegalRunTransition("started", "started")).toBe(false)
  })

  it("awakeables-and-runs.RUN_TRANSITIONS.3 — blocked may transition to completed, failed, or cancelled", () => {
    expect(isLegalRunTransition("blocked", "completed")).toBe(true)
    expect(isLegalRunTransition("blocked", "failed")).toBe(true)
    expect(isLegalRunTransition("blocked", "cancelled")).toBe(true)
    expect(isLegalRunTransition("blocked", "blocked")).toBe(false)
    expect(isLegalRunTransition("blocked", "started")).toBe(false)
  })

  it("awakeables-and-runs.RUN_TRANSITIONS.4 — completed/failed/cancelled are terminal", () => {
    expect(isTerminalRun("completed")).toBe(true)
    expect(isTerminalRun("failed")).toBe(true)
    expect(isTerminalRun("cancelled")).toBe(true)
    expect(isTerminalRun("started")).toBe(false)
    expect(isTerminalRun("blocked")).toBe(false)
  })

  it("awakeables-and-runs.RUN_TRANSITIONS.5 — terminal runs do not transition again", () => {
    const started = runValueOf(startRun({ runId: "run-5" }))
    const completed = completeRun(started, { result: "ok" }).value as RunValue
    expect(() => completeRun(completed, { result: "again" })).toThrow(IllegalRunTransition)
    expect(() => failRun(completed, { error: "e" })).toThrow(IllegalRunTransition)
    expect(() => cancelRun(completed, { terminalReason: "x" })).toThrow(IllegalRunTransition)
    expect(() => blockRun(completed, { blockedOnCompletionId: "c-1" })).toThrow(IllegalRunTransition)
    expect(isLegalRunTransition("completed", "started")).toBe(false)
    expect(isLegalRunTransition("completed", "blocked")).toBe(false)
    expect(isLegalRunTransition("failed", "cancelled")).toBe(false)
  })

  it("awakeables-and-runs.RUN_TRANSITIONS.6 — competing run terminals: first-valid-terminal-wins", () => {
    const started = runValueOf(startRun({ runId: "run-6" }))
    const a = completeRun(started, { result: "A" }).value as RunValue
    const b = failRun(started, { error: "B" }).value as RunValue
    const winner = foldRunRecords("run-6", [started, a, b])
    expect(winner?.state).toBe("completed")
    expect(winner?.result).toBe("A")
  })

  it("awakeables-and-runs.RUN_TRANSITIONS.7 — later conflicting run terminals remain as evidence", () => {
    const started = runValueOf(startRun({ runId: "run-7" }))
    const a = completeRun(started, { result: "A" }).value as RunValue
    const b = failRun(started, { error: "B" }).value as RunValue
    const records = [started, a, b]
    foldRunRecords("run-7", records)
    expect(records).toContain(b)
    expect(records).toHaveLength(3)
  })

  it("foldRunRecords — records for other runIds cannot affect the target winner", () => {
    // Mixed-id input: target run stays started; noise run terminalizes.
    // The target winner must remain started — noise records must be filtered out.
    const target = runValueOf(startRun({ runId: "run-target" }))
    const noiseStarted = runValueOf(startRun({ runId: "run-noise" }))
    const noiseCompleted = completeRun(noiseStarted, { result: "n" }).value as RunValue
    const noiseFailed = failRun(noiseStarted, { error: "n2" }).value as RunValue
    const winner = foldRunRecords("run-target", [
      noiseStarted,
      target,
      noiseCompleted,
      noiseFailed,
    ])
    expect(winner?.runId).toBe("run-target")
    expect(winner?.state).toBe("started")
  })

  it("foldRunRecords — empty input and target with no matching records both return undefined", () => {
    expect(foldRunRecords("run-x", [])).toBeUndefined()
    const other = runValueOf(startRun({ runId: "run-other" }))
    expect(foldRunRecords("run-missing", [other])).toBeUndefined()
  })
})

describe("awakeables-and-runs.RUN", () => {
  it("awakeables-and-runs.RUN.1 — durable.run represents a durable unit of work", () => {
    const event = startRun({ runId: "run-1" })
    expect(event.type).toBe("durable.run")
  })

  it("awakeables-and-runs.RUN.2 — a run can start", () => {
    const event = startRun({ runId: "run-2" })
    expect((event.value as RunValue).state).toBe("started")
  })

  it("awakeables-and-runs.RUN.3 — a run can block on a completion by recording blockedOnCompletionId", () => {
    const started = runValueOf(startRun({ runId: "run-3" }))
    const blocked = blockRun(started, { blockedOnCompletionId: "c-1" }).value as RunValue
    expect(blocked.state).toBe("blocked")
    expect(blocked.blockedOnCompletionId).toBe("c-1")
  })

  it("awakeables-and-runs.RUN.4 — a run can complete with durable result data", () => {
    const started = runValueOf(startRun({ runId: "run-4" }))
    const completed = completeRun(started, { result: { value: 1 } }).value as RunValue
    expect(completed.state).toBe("completed")
    expect(completed.result).toEqual({ value: 1 })
  })

  it("awakeables-and-runs.RUN.5 — a run can fail with durable error data", () => {
    const started = runValueOf(startRun({ runId: "run-5" }))
    const failed = failRun(started, { error: { code: "OOPS" } }).value as RunValue
    expect(failed.state).toBe("failed")
    expect(failed.error).toEqual({ code: "OOPS" })
  })

  it("awakeables-and-runs.RUN.6 — a run can cancel with durable terminal reason data", () => {
    const started = runValueOf(startRun({ runId: "run-6" }))
    const cancelled = cancelRun(started, { terminalReason: { kind: "user" } }).value as RunValue
    expect(cancelled.state).toBe("cancelled")
    expect(cancelled.terminalReason).toEqual({ kind: "user" })
  })

  it("awakeables-and-runs.RUN.7 — run state can be rebuilt from durable rows without a live runtime object", () => {
    // Pure fold over rebuilt records — no live object/promise/closure required.
    const started = runValueOf(startRun({ runId: "run-7" }))
    const blocked = blockRun(started, { blockedOnCompletionId: "c-1" }).value as RunValue
    const completed = completeRun(blocked, { result: "done" }).value as RunValue
    const rebuilt = foldRunRecords("run-7", [started, blocked, completed])
    expect(rebuilt?.state).toBe("completed")
    expect(rebuilt?.result).toBe("done")
  })

  it("awakeables-and-runs.RUN.8 — rejected awaited completion derives blocked run -> fail outcome", () => {
    const started = runValueOf(startRun({ runId: "run-8" }))
    const blocked = blockRun(started, { blockedOnCompletionId: "c-8" }).value as RunValue
    const pending = pendingValue(createPendingCompletion({ completionId: "c-8", kind: "timer" }))
    const rejected = rejectCompletion(pending, { error: "boom" }).value as CompletionValue
    const outcome = deriveBlockedRunOutcome(blocked, rejected)
    expect(outcome).toEqual({ kind: "fail", error: "boom" })
    // Applying the outcome terminalizes the blocked run.
    if (outcome.kind === "fail") {
      const failed = failRun(blocked, { error: outcome.error }).value as RunValue
      expect(failed.state).toBe("failed")
    }
  })

  it("awakeables-and-runs.RUN.9 — cancelled awaited completion derives blocked run -> cancel outcome", () => {
    const started = runValueOf(startRun({ runId: "run-9" }))
    const blocked = blockRun(started, { blockedOnCompletionId: "c-9" }).value as RunValue
    const pending = pendingValue(createPendingCompletion({ completionId: "c-9", kind: "timer" }))
    const cancelled = cancelCompletion(pending, { terminalReason: "ttl" }).value as CompletionValue
    const outcome = deriveBlockedRunOutcome(blocked, cancelled)
    expect(outcome).toEqual({ kind: "cancel", terminalReason: "ttl" })
  })

  it("awakeables-and-runs.RUN.10 — a blocked run is not permanently blocked once awaited completion terminalizes (rejected/cancelled minimal profile)", () => {
    const started = runValueOf(startRun({ runId: "run-10" }))
    const blocked = blockRun(started, { blockedOnCompletionId: "c-10" }).value as RunValue
    const pending = pendingValue(createPendingCompletion({ completionId: "c-10", kind: "timer" }))
    const rejected = rejectCompletion(pending, { error: "x" }).value as CompletionValue
    const cancelled = cancelCompletion(pending, { terminalReason: "y" }).value as CompletionValue
    expect(deriveBlockedRunOutcome(blocked, rejected).kind).not.toBe("noop")
    expect(deriveBlockedRunOutcome(blocked, cancelled).kind).not.toBe("noop")
    // Resolved-completion case is RUN.11 below — handed to ReadyWorkProjection in a later feature.
  })

  it("awakeables-and-runs.RUN.11 — resolved awaited completion does not directly terminalize the blocked run; ready-work derivation re-arms it later", () => {
    const started = runValueOf(startRun({ runId: "run-11" }))
    const blocked = blockRun(started, { blockedOnCompletionId: "c-11" }).value as RunValue
    const pending = pendingValue(createPendingCompletion({ completionId: "c-11", kind: "timer" }))
    const resolved = resolveCompletion(pending, { result: "ok" }).value as CompletionValue
    const outcome = deriveBlockedRunOutcome(blocked, resolved)
    expect(outcome).toEqual({ kind: "noop" })
  })

  it("deriveBlockedRunOutcome — noop when the run is not blocked or is blocked on a different completion", () => {
    const started = runValueOf(startRun({ runId: "run-noop" }))
    const pending = pendingValue(createPendingCompletion({ completionId: "c-x", kind: "timer" }))
    const resolved = resolveCompletion(pending, { result: 1 }).value as CompletionValue
    expect(deriveBlockedRunOutcome(started, resolved)).toEqual({ kind: "noop" })
    const blockedOnOther = blockRun(started, { blockedOnCompletionId: "c-other" })
      .value as RunValue
    expect(deriveBlockedRunOutcome(blockedOnOther, resolved)).toEqual({ kind: "noop" })
  })
})

describe("launchable-substrate-host.CLIENT_SURFACE.11 — startRun without data leaves the run row's data field absent", () => {
  it("startRun({ runId }) produces a RunValue with no data field", () => {
    const started = runValueOf(startRun({ runId: "run-data-absent" }))
    expect("data" in started).toBe(false)
    expect(started.state).toBe("started")
    expect(started.runId).toBe("run-data-absent")
  })
})

describe("launchable-substrate-host.CLIENT_SURFACE.12 — startRun preserves caller input as substrate-generic durable.run data", () => {
  it("startRun({ runId, data }) preserves the data value verbatim on the durable.run row", () => {
    const data = { kind: "review", target: "README.md" } as const
    const started = runValueOf(startRun({ runId: "run-data-present", data }))
    expect(started.data).toStrictEqual(data)
    expect(started.state).toBe("started")
  })

  it("startRun preserves arbitrary serializable shapes (string, array, nested object, null)", () => {
    const samples: ReadonlyArray<unknown> = [
      "plain-string",
      [1, 2, 3],
      { nested: { a: 1, b: ["x"] } },
      null,
    ]
    for (const data of samples) {
      const started = runValueOf(
        startRun({ runId: `run-data-${JSON.stringify(data).slice(0, 16)}`, data }),
      )
      expect(started.data).toStrictEqual(data)
    }
  })
})

describe("awakeables-and-runs constraints", () => {
  it("awakeables-and-runs.NO_SEPARATE_CONTINUATION_ROW_YET.1 — no separate continuation row family is exposed", () => {
    const m = substrate as unknown as Record<string, unknown>
    expect(m.ContinuationRowType).toBeUndefined()
    expect(m.ContinuationValue).toBeUndefined()
    expect(m.continuationRowType).toBeUndefined()
  })

  it("awakeables-and-runs.NO_SEPARATE_CONTINUATION_ROW_YET.2 — continuation is implicit in run state (RunValue exposes no continuation field)", () => {
    const started = runValueOf(startRun({ runId: "run-c" }))
    expect(Object.keys(started)).not.toContain("continuationId")
    expect(Object.keys(started)).not.toContain("continuation")
  })

  it("awakeables-and-runs.NO_SEPARATE_CONTINUATION_ROW_YET.3 — no separate wait row family alongside completion for the same role", () => {
    const m = substrate as unknown as Record<string, unknown>
    expect(m.WaitRowType).toBeUndefined()
    expect(m.waitRowType).toBeUndefined()
    expect(m.WaitValue).toBeUndefined()
  })

  it("awakeables-and-runs.NO_SEPARATE_CONTINUATION_ROW_YET.4 — this feature does not ship awakeable key construction helpers (state-machine module surface)", async () => {
    // Scope: state-machine.ts module. Slice 7 legitimately adds key helpers
    // from waits.ts because that slice now has a same-phase consumer
    // (DurableWaits.awakeable / awakeableGlobal).
    const sm = await import("../state-machine.js")
    const smNames = Object.keys(sm)
    for (const symbol of ["workScopedAwakeableKey", "globalAwakeableKey", "awakeableKey"]) {
      expect(smNames).not.toContain(symbol)
    }
  })

  it("awakeables-and-runs.NO_WORKFLOW_SDK_PRIMARY_MODEL.1 — no workflow orchestration SDK exposed as primary application model", () => {
    const m = substrate as unknown as Record<string, unknown>
    for (const symbol of [
      "Workflow",
      "defineWorkflow",
      "WorkflowRunner",
      "Step",
      "Saga",
      "Orchestrator",
    ]) {
      expect(m[symbol]).toBeUndefined()
    }
  })

  it("awakeables-and-runs.NO_WORKFLOW_SDK_PRIMARY_MODEL.2 — substrate progress is represented by durable records/completions/projections (state-machine returns ChangeEvents)", () => {
    const event = startRun({ runId: "run-x" })
    // Returned values are ChangeEvents with substrate row schemas, not workflow-step descriptors.
    expect(event).toMatchObject({
      type: "durable.run",
      key: "run-x",
      headers: { operation: "insert" },
    })
  })

  it("awakeables-and-runs.NO_WORKFLOW_SDK_PRIMARY_MODEL.3 — this feature owns completion/run state machines, not ready-work or claim ownership", async () => {
    // Scope: the state-machine module itself must not expose ready-work or
    // claim ownership symbols. Slice 4 legitimately adds deriveReadyWork to
    // the broader package surface from a different module (ready-work.ts).
    const sm = await import("../state-machine.js")
    const smNames = Object.keys(sm)
    for (const symbol of [
      "deriveReadyWork",
      "ReadyWorkProjection",
      "ReadyWorkItem",
      "claimReadyWork",
      "deriveClaimWinner",
    ]) {
      expect(smNames).not.toContain(symbol)
    }
  })
})
