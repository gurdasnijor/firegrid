import { DurableStream } from "@durable-streams/client"
import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  readRetainedClaimAttempts,
  readRetainedRunRecords,
} from "../retained-records.ts"
import type { CompletionValue, RunValue } from "../schema/rows.ts"
import {
  blockRun,
  cancelRun,
  completeRun,
  createPendingCompletion,
  failRun,
  resolveCompletion,
  startRun,
} from "./state-machine-sync.ts"
import { substrateState } from "../schema/state.ts"
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

describe("retained-records.readRetainedClaimAttempts", () => {
  it("returns claim attempts for the requested workId in append order", async () => {
    const url = freshStreamUrl("claims-order")
    const stream = await DurableStream.create({ url, contentType: "application/json" })
    for (const claim of [
      { claimId: "c-1", workId: "work-A", ownerId: "o1", observedCursor: "0_0", status: "attempted" as const },
      { claimId: "c-2", workId: "work-B", ownerId: "o2", observedCursor: "0_0", status: "attempted" as const },
      { claimId: "c-3", workId: "work-A", ownerId: "o3", observedCursor: "0_1", status: "attempted" as const },
    ]) {
      await stream.append(JSON.stringify(substrateState.claimAttempts.insert({ value: claim })))
    }

    const attempts = await Effect.runPromise(readRetainedClaimAttempts(url, "work-A"))
    expect(attempts.map((a) => a.claimId)).toEqual(["c-1", "c-3"])
    expect(attempts.map((a) => a.ownerId)).toEqual(["o1", "o3"])
  })

  it("filters out non-claim rows", async () => {
    const url = freshStreamUrl("claims-filter")
    const startedEvent = startRun({ runId: "run-x" })
    const claimEvent = substrateState.claimAttempts.insert({
      value: { claimId: "c-x", workId: "work-x", ownerId: "o", observedCursor: "0_0", status: "attempted" },
    })
    await publishToStream(url, [startedEvent, claimEvent])

    const attempts = await Effect.runPromise(readRetainedClaimAttempts(url, "work-x"))
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.claimId).toBe("c-x")
  })

  it("returns empty when no attempts match the workId", async () => {
    const url = freshStreamUrl("claims-empty")
    await publishToStream(url, [])
    const attempts = await Effect.runPromise(readRetainedClaimAttempts(url, "missing-workid"))
    expect(attempts).toEqual([])
  })
})

describe("retained-records.readRetainedRunRecords", () => {
  it("returns run records for the requested runId in append order", async () => {
    const url = freshStreamUrl("runs-order")
    const startedEvent = startRun({ runId: "run-A" })
    const startedRun = startedEvent.value as RunValue
    const blockedEvent = blockRun(startedRun, { blockedOnCompletionId: "c-1" })
    const startedRunB = startRun({ runId: "run-B" })
    await publishToStream(url, [startedEvent, blockedEvent, startedRunB])

    const records = await Effect.runPromise(readRetainedRunRecords(url, "run-A"))
    expect(records).toHaveLength(2)
    expect(records.map((r) => r.state)).toEqual(["started", "blocked"])
    expect(records[0]?.runId).toBe("run-A")
    expect(records[1]?.blockedOnCompletionId).toBe("c-1")
  })

  it("filters out completion and other rows", async () => {
    const url = freshStreamUrl("runs-filter")
    const pendingEvent = createPendingCompletion({ completionId: "c-y", kind: "timer" })
    const pendingCompletion = pendingEvent.value as CompletionValue
    const resolvedEvent = resolveCompletion(pendingCompletion, { result: "ok" })
    const startedEvent = startRun({ runId: "run-y" })
    await publishToStream(url, [pendingEvent, resolvedEvent, startedEvent])

    const records = await Effect.runPromise(readRetainedRunRecords(url, "run-y"))
    expect(records).toHaveLength(1)
    expect(records[0]?.state).toBe("started")
  })

  it("preserves multiple terminal records as evidence (not collapsed)", async () => {
    const url = freshStreamUrl("runs-multi-terminal")
    const startedEvent = startRun({ runId: "run-z" })
    const startedRun = startedEvent.value as RunValue
    const completedEvent = completeRun(startedRun, { result: "first" })
    const failedEvent = failRun(startedRun, { error: "second" })
    const cancelledEvent = cancelRun(startedRun, { terminalReason: "third" })
    await publishToStream(url, [startedEvent, completedEvent, failedEvent, cancelledEvent])

    const records = await Effect.runPromise(readRetainedRunRecords(url, "run-z"))
    expect(records.map((r) => r.state)).toEqual(["started", "completed", "failed", "cancelled"])
  })
})
