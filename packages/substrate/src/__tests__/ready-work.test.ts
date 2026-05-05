import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type {
  CompletionValue,
  RunValue,
} from "../rows.ts"
import { FOLD_VERSION, type ProjectionSnapshot } from "../projection.ts"
import { deriveReadyWork } from "../ready-work.ts"
import {
  blockRun,
  createPendingCompletion,
  resolveCompletion,
  startRun,
} from "../state-machine.ts"
import { rebuildProjection } from "../stream.ts"
import {
  freshStreamUrl,
  publishToStream,
  startTestServer,
  stopTestServer,
} from "./helpers.ts"

beforeAll(async () => {
  await startTestServer()
})

afterAll(async () => {
  await stopTestServer()
})

const snapshotOf = (
  runs: ReadonlyArray<RunValue>,
  completions: ReadonlyArray<CompletionValue>,
): ProjectionSnapshot => ({
  foldVersion: FOLD_VERSION,
  runs: new Map(runs.map((r) => [r.runId, r])),
  completions: new Map(completions.map((c) => [c.completionId, c])),
  claimAttempts: new Map(),
})

describe("ready-work-projection.SOURCE_PROJECTIONS", () => {
  it("ready-work-projection.SOURCE_PROJECTIONS.1 — CompletionProjection (snapshot.completions) is keyed by completionId and consumed here", () => {
    const completion: CompletionValue = {
      completionId: "c-1",
      kind: "externally_resolved_awakeable",
      state: "resolved",
      result: "x",
    }
    const run: RunValue = { runId: "run-1", state: "blocked", blockedOnCompletionId: "c-1" }
    const projection = deriveReadyWork(snapshotOf([run], [completion]))
    expect(projection.readyWork.get("run-1")?.completionId).toBe("c-1")
  })

  it("ready-work-projection.SOURCE_PROJECTIONS.2 — RunProjection (snapshot.runs) is keyed by runId and consumed here", () => {
    const completion: CompletionValue = {
      completionId: "c-2",
      kind: "timer",
      state: "resolved",
      result: 1,
    }
    const run: RunValue = { runId: "run-2", state: "blocked", blockedOnCompletionId: "c-2" }
    const projection = deriveReadyWork(snapshotOf([run], [completion]))
    expect(projection.readyWork.get("run-2")?.runId).toBe("run-2")
  })

  it("ready-work-projection.SOURCE_PROJECTIONS.3 — derivation reads rebuilt projection state, not live wait state", () => {
    // Structural: deriveReadyWork has only one parameter (the snapshot) and
    // reaches no module-level / live state. Calling it twice with the same
    // input yields equivalent output.
    const completion: CompletionValue = {
      completionId: "c-3",
      kind: "timer",
      state: "resolved",
      result: "v",
    }
    const run: RunValue = { runId: "run-3", state: "blocked", blockedOnCompletionId: "c-3" }
    const a = deriveReadyWork(snapshotOf([run], [completion]))
    const b = deriveReadyWork(snapshotOf([run], [completion]))
    expect(Object.fromEntries(a.readyWork)).toEqual(Object.fromEntries(b.readyWork))
  })
})

describe("ready-work-projection.READY_WORK_PROJECTION", () => {
  it("ready-work-projection.READY_WORK_PROJECTION.1 — ReadyWorkProjection is a derived view, not a producer-authored row", () => {
    // Structural: there is no `ReadyWorkRowType` constant, no
    // `substrateState.readyWork` collection, no producer method that authors
    // ready-work. The projection comes only from `deriveReadyWork`.
    const projection = deriveReadyWork(snapshotOf([], []))
    expect(projection.readyWork).toBeInstanceOf(Map)
    expect(projection.readyWork.size).toBe(0)
  })

  it("ready-work-projection.READY_WORK_PROJECTION.2 — blocked + blockedOnCompletionId + resolved completion derives ready", () => {
    const completion: CompletionValue = {
      completionId: "c-r",
      kind: "externally_resolved_awakeable",
      state: "resolved",
      result: { v: 42 },
    }
    const run: RunValue = { runId: "run-r", state: "blocked", blockedOnCompletionId: "c-r" }
    const projection = deriveReadyWork(snapshotOf([run], [completion]))
    expect(projection.readyWork.get("run-r")).toEqual({
      runId: "run-r",
      completionId: "c-r",
      result: { v: 42 },
    })
  })

  it("ready-work-projection.READY_WORK_PROJECTION.3 — rejected completion does not derive ready work", () => {
    const completion: CompletionValue = {
      completionId: "c-rej",
      kind: "timer",
      state: "rejected",
      error: "boom",
    }
    const run: RunValue = { runId: "run-rej", state: "blocked", blockedOnCompletionId: "c-rej" }
    const projection = deriveReadyWork(snapshotOf([run], [completion]))
    expect(projection.readyWork.size).toBe(0)
  })

  it("ready-work-projection.READY_WORK_PROJECTION.4 — cancelled completion does not derive ready work", () => {
    const completion: CompletionValue = {
      completionId: "c-can",
      kind: "timer",
      state: "cancelled",
      terminalReason: "ttl",
    }
    const run: RunValue = { runId: "run-can", state: "blocked", blockedOnCompletionId: "c-can" }
    const projection = deriveReadyWork(snapshotOf([run], [completion]))
    expect(projection.readyWork.size).toBe(0)
  })

  it("ready-work-projection.READY_WORK_PROJECTION.5 — completed run does not derive ready work", () => {
    const completion: CompletionValue = {
      completionId: "c-c",
      kind: "timer",
      state: "resolved",
      result: 1,
    }
    const run: RunValue = { runId: "run-c", state: "completed", result: "done" }
    const projection = deriveReadyWork(snapshotOf([run], [completion]))
    expect(projection.readyWork.size).toBe(0)
  })

  it("ready-work-projection.READY_WORK_PROJECTION.5 — failed run does not derive ready work", () => {
    const completion: CompletionValue = {
      completionId: "c-f",
      kind: "timer",
      state: "resolved",
      result: 1,
    }
    const run: RunValue = { runId: "run-f", state: "failed", error: "x" }
    const projection = deriveReadyWork(snapshotOf([run], [completion]))
    expect(projection.readyWork.size).toBe(0)
  })

  it("ready-work-projection.READY_WORK_PROJECTION.6 — derivation is deterministic over rebuilt projection state", () => {
    const completions: CompletionValue[] = [
      { completionId: "c-A", kind: "timer", state: "resolved", result: "A" },
      { completionId: "c-B", kind: "timer", state: "pending" },
    ]
    const runs: RunValue[] = [
      { runId: "run-A", state: "blocked", blockedOnCompletionId: "c-A" },
      { runId: "run-B", state: "blocked", blockedOnCompletionId: "c-B" },
      { runId: "run-C", state: "started" },
    ]
    const snap = snapshotOf(runs, completions)
    const a = deriveReadyWork(snap)
    const b = deriveReadyWork(snap)
    expect(Object.fromEntries(a.readyWork)).toEqual(Object.fromEntries(b.readyWork))
    // Only run-A is ready.
    expect([...a.readyWork.keys()]).toEqual(["run-A"])
  })

  it("ready-work-projection.READY_WORK_PROJECTION.7 — items expose runId, completionId, and the resolved result", () => {
    const completion: CompletionValue = {
      completionId: "c-fields",
      kind: "externally_resolved_awakeable",
      state: "resolved",
      result: "the-result",
    }
    const run: RunValue = { runId: "run-fields", state: "blocked", blockedOnCompletionId: "c-fields" }
    const projection = deriveReadyWork(snapshotOf([run], [completion]))
    const item = projection.readyWork.get("run-fields")
    expect(item).toBeDefined()
    expect(Object.keys(item ?? {}).sort()).toEqual(["completionId", "result", "runId"])
    expect(item).toEqual({
      runId: "run-fields",
      completionId: "c-fields",
      result: "the-result",
    })
  })

  it("ready-work-projection.READY_WORK_PROJECTION.8 — items are keyed by runId", () => {
    const completion: CompletionValue = {
      completionId: "c-key",
      kind: "timer",
      state: "resolved",
      result: 0,
    }
    const run: RunValue = { runId: "run-key", state: "blocked", blockedOnCompletionId: "c-key" }
    const projection = deriveReadyWork(snapshotOf([run], [completion]))
    const entries = [...projection.readyWork.entries()]
    expect(entries).toHaveLength(1)
    const [key, value] = entries[0]!
    expect(key).toBe("run-key")
    expect(value.runId).toBe(key)
  })

  it("ready-work-projection.READY_WORK_PROJECTION.9 — derivation is exposed as a pure function over rebuilt projection state", () => {
    expect(typeof deriveReadyWork).toBe("function")
    // No side effects: calling with an empty snapshot returns an empty
    // projection without touching anything outside the input.
    const before = snapshotOf([], [])
    const projection = deriveReadyWork(before)
    expect(projection.readyWork.size).toBe(0)
    expect(before.runs.size).toBe(0) // input not mutated
  })

  it("ready-work-projection.READY_WORK_PROJECTION.10 — projection carries the source projection foldVersion", () => {
    const projection = deriveReadyWork(snapshotOf([], []))
    expect(projection.foldVersion).toBe(FOLD_VERSION)
  })

  it("blocked run with no blockedOnCompletionId does not derive ready work (defensive)", () => {
    const run: RunValue = { runId: "run-x", state: "blocked" }
    const projection = deriveReadyWork(snapshotOf([run], []))
    expect(projection.readyWork.size).toBe(0)
  })

  it("blocked run referencing a missing completion does not derive ready work (defensive)", () => {
    const run: RunValue = { runId: "run-y", state: "blocked", blockedOnCompletionId: "c-missing" }
    const projection = deriveReadyWork(snapshotOf([run], []))
    expect(projection.readyWork.size).toBe(0)
  })

  it("blocked run with pending completion does not derive ready work (still waiting)", () => {
    const completion: CompletionValue = {
      completionId: "c-p",
      kind: "timer",
      state: "pending",
    }
    const run: RunValue = { runId: "run-p", state: "blocked", blockedOnCompletionId: "c-p" }
    const projection = deriveReadyWork(snapshotOf([run], [completion]))
    expect(projection.readyWork.size).toBe(0)
  })

  it("multiple ready runs all surface in the projection", () => {
    const completions: CompletionValue[] = [
      { completionId: "c-1", kind: "timer", state: "resolved", result: 1 },
      { completionId: "c-2", kind: "timer", state: "resolved", result: 2 },
    ]
    const runs: RunValue[] = [
      { runId: "run-1", state: "blocked", blockedOnCompletionId: "c-1" },
      { runId: "run-2", state: "blocked", blockedOnCompletionId: "c-2" },
    ]
    const projection = deriveReadyWork(snapshotOf(runs, completions))
    expect([...projection.readyWork.keys()].sort()).toEqual(["run-1", "run-2"])
    expect(projection.readyWork.get("run-1")?.result).toBe(1)
    expect(projection.readyWork.get("run-2")?.result).toBe(2)
  })
})

describe("ready-work-projection — integration: rebuildProjection + deriveReadyWork over real DurableStreamTestServer", () => {
  it("ready-work-projection.READY_WORK_PROJECTION.6 — composing rebuildProjection then deriveReadyWork yields a deterministic ready view", async () => {
    const url = freshStreamUrl("ready-integration")

    // Compose state-machine builders to produce the canonical event sequence.
    const startedEvent = startRun({ runId: "run-i" })
    const startedRun = startedEvent.value as RunValue
    const pendingEvent = createPendingCompletion({
      completionId: "c-i",
      kind: "externally_resolved_awakeable",
    })
    const pendingCompletion = pendingEvent.value as CompletionValue
    const blockedEvent = blockRun(startedRun, { blockedOnCompletionId: "c-i" })
    const resolvedEvent = resolveCompletion(pendingCompletion, { result: "ok" })

    await publishToStream(url, [
      startedEvent,
      pendingEvent,
      blockedEvent,
      resolvedEvent,
    ])

    const snapshot = await rebuildProjection({ url })
    const projection = deriveReadyWork(snapshot)
    expect(projection.readyWork.get("run-i")).toEqual({
      runId: "run-i",
      completionId: "c-i",
      result: "ok",
    })

    // Determinism: an independent rebuild + derive yields the same view.
    const snapshot2 = await rebuildProjection({ url })
    const projection2 = deriveReadyWork(snapshot2)
    expect(Object.fromEntries(projection.readyWork)).toEqual(
      Object.fromEntries(projection2.readyWork),
    )
  })
})

describe("ready-work-projection.FIRST_PHASE_LIMITS", () => {
  it("ready-work-projection.FIRST_PHASE_LIMITS.4 — ready-work module owns derivation only (no completion/run state-machine, claim, or operator surface)", async () => {
    // Pure structural: ready-work.ts exports only the projection contract.
    const mod = await import("../ready-work.ts")
    const exportNames = Object.keys(mod).sort()
    expect(exportNames).toEqual(["ReadyWorkItem", "deriveReadyWork"])
  })

  it("ready-work-projection.FIRST_PHASE_LIMITS.5 — claim attempts / winners / handler invocation / terminal owner authority are not produced here", () => {
    // Derivation does not touch claimAttempts and emits no run/completion terminal records.
    const completion: CompletionValue = {
      completionId: "c-fl",
      kind: "timer",
      state: "resolved",
      result: "x",
    }
    const run: RunValue = { runId: "run-fl", state: "blocked", blockedOnCompletionId: "c-fl" }
    const projection = deriveReadyWork(snapshotOf([run], [completion]))
    expect(projection).not.toHaveProperty("claimWinner")
    expect(projection).not.toHaveProperty("claimAttempts")
    expect(projection).not.toHaveProperty("handlerInvocations")
    expect(projection).not.toHaveProperty("terminalRecords")
  })
})
