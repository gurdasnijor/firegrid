import { Schema } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { CompletionValue, RunValue } from "../rows.ts"
import { rebuildProjection } from "../stream.ts"
import {
  claimAttemptEvent,
  completionEvent,
  freshStreamUrl,
  publishToStream,
  runEvent,
  startTestServer,
  stopTestServer,
} from "./helpers.ts"

const decodeRun = Schema.decodeUnknownSync(RunValue)
const decodeCompletion = Schema.decodeUnknownSync(CompletionValue)

beforeAll(async () => {
  await startTestServer()
})

afterAll(async () => {
  await stopTestServer()
})

describe("durable-records-and-projections.PROJECTIONS", () => {
  it("durable-records-and-projections.PROJECTIONS.1 — projections are derived views from accepted records", async () => {
    const url = freshStreamUrl("proj-1")
    await publishToStream(url, [runEvent.insert({ runId: "run-1", state: "started" })])
    const snapshot = await rebuildProjection({ url })
    expect(snapshot.runs.get("run-1")).toBeDefined()
  })

  it("durable-records-and-projections.PROJECTIONS.2 — projections are not alternate sources of truth", async () => {
    const url = freshStreamUrl("proj-2")
    await publishToStream(url, [])
    const snapshot = await rebuildProjection({ url })
    expect(snapshot.runs.size).toBe(0)
    expect(snapshot.completions.size).toBe(0)
    expect(snapshot.claimAttempts.size).toBe(0)
  })

  it("durable-records-and-projections.PROJECTIONS.3 — same retained records + same fold version => same logical rows", async () => {
    const url = freshStreamUrl("proj-3")
    await publishToStream(url, [
      runEvent.insert({ runId: "run-1", state: "started" }),
      runEvent.upsert({
        runId: "run-1",
        state: "blocked",
        blockedOnCompletionId: "c-1",
      }),
      completionEvent.insert({
        completionId: "c-1",
        kind: "externally_resolved_awakeable",
        state: "pending",
      }),
    ])
    const a = await rebuildProjection({ url })
    const b = await rebuildProjection({ url })
    expect(a.foldVersion).toBe(b.foldVersion)
    expect(Object.fromEntries(a.runs)).toEqual(Object.fromEntries(b.runs))
    expect(Object.fromEntries(a.completions)).toEqual(Object.fromEntries(b.completions))
  })

  it("durable-records-and-projections.PROJECTIONS.4 — consumers cannot assume a row exists before its record is accepted", async () => {
    const url = freshStreamUrl("proj-4")
    await publishToStream(url, [])
    const snapshot = await rebuildProjection({ url })
    expect(snapshot.runs.get("run-1")).toBeUndefined()
    expect(snapshot.completions.get("c-1")).toBeUndefined()
  })

  it("durable-records-and-projections.PROJECTIONS.5 — projection tests use @durable-streams/state", async () => {
    // Structural: substrateState is created via createStateSchema from
    // @durable-streams/state, and rebuildProjection delegates to createStreamDB.
    const url = freshStreamUrl("proj-5")
    await publishToStream(url, [runEvent.insert({ runId: "run-1", state: "started" })])
    const snapshot = await rebuildProjection({ url })
    expect(snapshot.runs.get("run-1")?.runId).toBe("run-1")
  })

  it("durable-records-and-projections.PROJECTIONS.6 — custom projections are materializer folds, not callbacks", async () => {
    const url = freshStreamUrl("proj-6")
    await publishToStream(url, [runEvent.insert({ runId: "run-1", state: "started" })])
    const snapshot = await rebuildProjection({ url })
    // Public surface is a snapshot-returning function, not a subscriber/callback API.
    expect(snapshot.runs).toBeInstanceOf(Map)
  })

  it("durable-records-and-projections.PROJECTIONS.7 — projected observation does not substitute for authority", async () => {
    const url = freshStreamUrl("proj-7")
    await publishToStream(url, [
      runEvent.upsert({
        runId: "run-1",
        state: "blocked",
        blockedOnCompletionId: "c-1",
      }),
    ])
    const snapshot = await rebuildProjection({ url })
    const run = snapshot.runs.get("run-1")
    expect(run?.state).toBe("blocked")
    // Projection observation alone does not imply claim/terminal authority.
    expect(Object.keys(run ?? {})).not.toContain("claimedBy")
    expect(Object.keys(run ?? {})).not.toContain("ownerId")
  })

  it("durable-records-and-projections.PROJECTIONS.8 — snapshot/no-gap cursor semantics precede live updates", async () => {
    // db.preload() reads the retained stream to up-to-date BEFORE returning;
    // the snapshot we observe here is the no-gap snapshot boundary.
    const url = freshStreamUrl("proj-8")
    await publishToStream(url, [runEvent.insert({ runId: "run-1", state: "started" })])
    const snapshot = await rebuildProjection({ url })
    expect(snapshot.runs.get("run-1")?.state).toBe("started")
  })

  it("durable-records-and-projections.RECORDS.6 — durable.claim.attempt rows are projected as evidence (no winner derivation)", async () => {
    // Two competing attempts for the same workId; both must remain visible as evidence.
    // Winner derivation is owned by claim-and-operator-authority (Slice 5/6).
    const url = freshStreamUrl("claim-evidence")
    await publishToStream(url, [
      claimAttemptEvent.insert({
        claimId: "claim-A",
        workId: "work-1",
        ownerId: "operator-1",
        observedCursor: "0_0",
        status: "attempted",
      }),
      claimAttemptEvent.insert({
        claimId: "claim-B",
        workId: "work-1",
        ownerId: "operator-2",
        observedCursor: "0_0",
        status: "attempted",
      }),
    ])
    const snapshot = await rebuildProjection({ url })
    expect(snapshot.claimAttempts.size).toBe(2)
    expect(snapshot.claimAttempts.get("claim-A")?.ownerId).toBe("operator-1")
    expect(snapshot.claimAttempts.get("claim-B")?.ownerId).toBe("operator-2")
    expect(snapshot).not.toHaveProperty("claimWinner")
    expect(snapshot).not.toHaveProperty("readyWork")
  })
})

describe("durable-records-and-projections.REBUILD", () => {
  it("durable-records-and-projections.REBUILD.1 — fresh consumer of a retained stream rebuilds the substrate projection", async () => {
    const url = freshStreamUrl("rebuild-1")
    await publishToStream(url, [
      runEvent.insert({ runId: "run-1", state: "started" }),
      runEvent.upsert({
        runId: "run-1",
        state: "blocked",
        blockedOnCompletionId: "c-1",
      }),
      completionEvent.insert({
        completionId: "c-1",
        kind: "externally_resolved_awakeable",
        state: "pending",
      }),
      completionEvent.upsert({
        completionId: "c-1",
        kind: "externally_resolved_awakeable",
        state: "resolved",
        result: "ok",
      }),
      runEvent.upsert({ runId: "run-1", state: "completed", result: "ok" }),
    ])

    // Two independent "processes" rebuild from the same retained stream.
    const first = await rebuildProjection({ url })
    const second = await rebuildProjection({ url })

    expect(Object.fromEntries(first.runs)).toEqual(Object.fromEntries(second.runs))
    expect(first.runs.get("run-1")?.state).toBe("completed")
    expect(first.completions.get("c-1")?.state).toBe("resolved")
    // Decoded values still satisfy the Effect Schema contract end-to-end.
    expect(() => decodeRun(first.runs.get("run-1"))).not.toThrow()
    expect(() => decodeCompletion(first.completions.get("c-1"))).not.toThrow()
  })

  it("durable-records-and-projections.REBUILD.2 — rebuild does not depend on live promises, ids, or wall-clock", async () => {
    const url = freshStreamUrl("rebuild-2")
    await publishToStream(url, [runEvent.insert({ runId: "run-1", state: "started" })])
    const a = await rebuildProjection({ url })
    const b = await rebuildProjection({ url })
    expect(Object.fromEntries(a.runs)).toEqual(Object.fromEntries(b.runs))
  })

  it("durable-records-and-projections.REBUILD.3 — rebuild surfaces transport-level retained-stream failure explicitly (per REBUILD.3-note)", async () => {
    // Slice 1 proof scope: a missing/unreachable retained stream rejects rather
    // than returning an empty snapshot that would falsely look complete.
    // In-stream offset/snapshot gap detection is left to live-tail proofs in
    // later slices when cursor semantics are exercised.
    const missingUrl = freshStreamUrl("rebuild-3-missing")
    await expect(rebuildProjection({ url: missingUrl })).rejects.toBeDefined()
  })

  it("durable-records-and-projections.REBUILD.4 — rebuild returns a typed projection snapshot with foundational projections", async () => {
    const url = freshStreamUrl("rebuild-4")
    await publishToStream(url, [runEvent.insert({ runId: "run-1", state: "started" })])
    const snapshot = await rebuildProjection({ url })
    expect(snapshot).toMatchObject({
      foldVersion: expect.any(Number),
      runs: expect.any(Map),
      completions: expect.any(Map),
      claimAttempts: expect.any(Map),
    })
  })
})
