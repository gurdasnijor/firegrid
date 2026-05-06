import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { CompletionKind } from "../protocol/schema/rows.ts"
import { rebuildProjection } from "../stream.ts"
import {
  claimAttemptEvent,
  completionEvent,
  freshStreamUrl,
  publishToStream,
  runEvent,
  startTestServer,
  stopTestServer,
  traceEvent,
} from "./helpers.ts"

beforeAll(async () => {
  await startTestServer()
})

afterAll(async () => {
  await stopTestServer()
})

describe("durable-records-and-projections.RECORDS", () => {
  it("durable-records-and-projections.RECORDS.1 — accepted records are immutable facts", async () => {
    const event = runEvent.insert({ runId: "run-1", state: "started" })
    const before = structuredClone(event)
    const url = freshStreamUrl("records-1")
    await publishToStream(url, [event])
    expect(event).toEqual(before)
  })

  it("durable-records-and-projections.RECORDS.2 — records carry type, key, value, headers", () => {
    const event = runEvent.insert({ runId: "run-1", state: "started" })
    expect(event).toMatchObject({
      type: "durable.run",
      key: "run-1",
      value: { runId: "run-1" },
      headers: { operation: "insert" },
    })
  })

  it("durable-records-and-projections.RECORDS.3 — stream position is authoritative for replay order", async () => {
    const url = freshStreamUrl("records-3")
    await publishToStream(url, [
      runEvent.insert({ runId: "run-1", state: "started" }),
      runEvent.upsert({
        runId: "run-1",
        state: "blocked",
        blockedOnCompletionId: "c-1",
      }),
      runEvent.upsert({ runId: "run-1", state: "completed", result: 42 }),
    ])
    const snapshot = await rebuildProjection({ url })
    expect(snapshot.runs.get("run-1")?.state).toBe("completed")
  })

  it("durable-records-and-projections.RECORDS.4 — wall-clock timestamps are not ordering authority", async () => {
    const earlier = "2026-05-03T12:00:00.000Z"
    const later = "2026-05-03T13:00:00.000Z"
    const url = freshStreamUrl("records-4")
    // First by stream position carries a LATER timestamp; second carries an EARLIER one.
    // Stream position must win: rebuilt state should reflect the second append (failed).
    await publishToStream(url, [
      runEvent.insertWithHeaders(
        { runId: "run-1", state: "completed", result: "first-by-position" },
        { timestamp: later },
      ),
      runEvent.upsertWithHeaders(
        { runId: "run-1", state: "failed", error: "second-by-position" },
        { timestamp: earlier },
      ),
    ])
    const snapshot = await rebuildProjection({ url })
    expect(snapshot.runs.get("run-1")?.state).toBe("failed")
  })

  it("durable-records-and-projections.RECORDS.5 — rebuild data lives in durable row data, not adapter metadata", async () => {
    const url = freshStreamUrl("records-5")
    await publishToStream(url, [
      completionEvent.insert({
        completionId: "c-1",
        kind: "timer",
        state: "pending",
      }),
      completionEvent.upsert({
        completionId: "c-1",
        kind: "timer",
        state: "resolved",
        result: { firedAt: "captured-durably" },
      }),
    ])
    const snapshot = await rebuildProjection({ url })
    const completion = snapshot.completions.get("c-1")
    expect(completion?.state).toBe("resolved")
    expect(completion?.result).toEqual({ firedAt: "captured-durably" })
  })

  it("durable-records-and-projections.RECORDS.6 — foundational families are run, completion, claim.attempt", async () => {
    const url = freshStreamUrl("records-6")
    await publishToStream(url, [
      runEvent.insert({ runId: "run-1", state: "started" }),
      completionEvent.insert({ completionId: "c-1", kind: "timer", state: "pending" }),
      claimAttemptEvent.insert({
        claimId: "claim-1",
        workId: "work-1",
        ownerId: "operator-1",
        observedCursor: "0_0",
        status: "attempted",
      }),
    ])
    const snapshot = await rebuildProjection({ url })
    expect(snapshot.runs.get("run-1")).toBeDefined()
    expect(snapshot.completions.get("c-1")).toBeDefined()
    expect(snapshot.claimAttempts.get("claim-1")).toBeDefined()
  })

  it("durable-records-and-projections.RECORDS.7 — completion variants are kinds, not separate families", async () => {
    const kinds = CompletionKind.literals
    const url = freshStreamUrl("records-7")
    await publishToStream(
      url,
      kinds.map((kind) =>
        completionEvent.insert({ completionId: `c-${kind}`, kind, state: "pending" }),
      ),
    )
    const snapshot = await rebuildProjection({ url })
    for (const kind of kinds) {
      expect(snapshot.completions.get(`c-${kind}`)?.kind).toBe(kind)
    }
  })

  it("durable-records-and-projections.RECORDS.8 — durable.trace is observability, not authority", async () => {
    const url = freshStreamUrl("records-8")
    await publishToStream(url, [
      traceEvent.insert({ traceId: "t-1", kind: "schedule.registered" }),
    ])
    const snapshot = await rebuildProjection({ url })
    // Trace rows do not surface in any of the foundational projections.
    expect(snapshot.runs.size).toBe(0)
    expect(snapshot.completions.size).toBe(0)
    expect(snapshot.claimAttempts.size).toBe(0)
  })
})
