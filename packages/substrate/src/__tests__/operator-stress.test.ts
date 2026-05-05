import { DurableStream } from "@durable-streams/client"
import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  firstValidClaim,
  processReadyWorkItem,
} from "../operator.ts"
import { deriveReadyWork, type ReadyWorkItem } from "../ready-work.ts"
import {
  readRetainedClaimAttempts,
  readRetainedRunRecords,
} from "../retained-records.ts"
import type { CompletionValue, RunValue } from "../rows.ts"
import {
  blockRun,
  cancelRun,
  completeRun,
  createPendingCompletion,
  failRun,
  foldRunRecords,
  resolveCompletion,
  startRun,
} from "../state-machine.ts"
import { substrateState } from "../state-schema.ts"
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

async function seedReadyWork(
  label: string,
  runId: string,
  completionId: string,
  result: unknown,
): Promise<{ url: string; readyItem: ReadyWorkItem }> {
  const url = freshStreamUrl(label)
  const startedEvent = startRun({ runId })
  const startedRun = startedEvent.value as RunValue
  const pendingEvent = createPendingCompletion({
    completionId,
    kind: "externally_resolved_awakeable",
  })
  const pendingCompletion = pendingEvent.value as CompletionValue
  const blockedEvent = blockRun(startedRun, { blockedOnCompletionId: completionId })
  const resolvedEvent = resolveCompletion(pendingCompletion, { result })
  await publishToStream(url, [startedEvent, pendingEvent, blockedEvent, resolvedEvent])

  const snapshot = await rebuildProjection({ url })
  const projection = deriveReadyWork(snapshot)
  const readyItem = projection.readyWork.get(runId)
  if (readyItem === undefined) throw new Error("expected ready item")
  return { url, readyItem }
}

describe("claim-and-operator-authority — competing claim attempts", () => {
  it("claim-and-operator-authority.CLAIM_AUTHORITY.1 + .7 — first-by-stream-order claim wins; later different-owner attempt loses (raw retained fold)", async () => {
    const { url, readyItem } = await seedReadyWork("compete-different-owner", "run-1", "c-1", "v")

    // Pre-seed an earlier different-owner claim.
    const earlier = substrateState.claimAttempts.insert({
      value: {
        claimId: "earlier",
        workId: "run-1",
        ownerId: "owner-first",
        observedCursor: "0_0",
        status: "attempted",
      },
    })
    const stream = await DurableStream.connect({ url })
    await stream.append(JSON.stringify(earlier))

    // Operator now attempts and must lose (different-owner earlier wins).
    const outcome = await Effect.runPromise(
      processReadyWorkItem({
        streamUrl: url,
        ownerId: "owner-late",
        item: readyItem,
        handler: () => Effect.succeed("never"),
        claimId: "later",
      }),
    )
    expect(outcome.kind).toBe("claim-lost")
    if (outcome.kind === "claim-lost") {
      expect(outcome.winner.claimId).toBe("earlier")
      expect(outcome.winner.ownerId).toBe("owner-first")
    }

    // Authority assertion: the raw retained claim fold agrees.
    const attempts = await Effect.runPromise(readRetainedClaimAttempts(url, "run-1"))
    expect(firstValidClaim("run-1", attempts)?.claimId).toBe("earlier")
  })

  it("claim-and-operator-authority.CLAIM_AUTHORITY.2 + .8 — same-owner duplicate is duplicate evidence, NOT a second handler invocation", async () => {
    const { url, readyItem } = await seedReadyWork("compete-same-owner", "run-2", "c-2", "v")

    const earlier = substrateState.claimAttempts.insert({
      value: {
        claimId: "first-attempt",
        workId: "run-2",
        ownerId: "owner-A",
        observedCursor: "0_0",
        status: "attempted",
      },
    })
    const stream = await DurableStream.connect({ url })
    await stream.append(JSON.stringify(earlier))

    let invoked = false
    const outcome = await Effect.runPromise(
      processReadyWorkItem({
        streamUrl: url,
        ownerId: "owner-A", // same owner as the earlier claim
        item: readyItem,
        handler: () =>
          Effect.sync(() => {
            invoked = true
            return "should-not-run"
          }),
        claimId: "second-attempt",
      }),
    )
    expect(outcome.kind).toBe("claim-lost")
    expect(invoked).toBe(false)
    if (outcome.kind === "claim-lost") {
      expect(outcome.winner.claimId).toBe("first-attempt")
      expect(outcome.winner.ownerId).toBe("owner-A") // same as our ownerId
    }

    // Both attempts preserved as evidence (CLAIM_ATTEMPT.4).
    const snapshot = await rebuildProjection({ url })
    const claims = [...snapshot.claimAttempts.values()].filter((c) => c.workId === "run-2")
    expect(claims).toHaveLength(2)
  })

  it("claim-and-operator-authority.CLAIM_ATTEMPT.4 + CLAIM_AUTHORITY.7 — many competing claims preserved; raw retained fold returns the first by stream order", async () => {
    const { url, readyItem } = await seedReadyWork("many-competing", "run-3", "c-3", "v")

    const stream = await DurableStream.connect({ url })
    for (const ownerId of ["owner-1", "owner-2", "owner-3"]) {
      await stream.append(
        JSON.stringify(
          substrateState.claimAttempts.insert({
            value: {
              claimId: `pre-${ownerId}`,
              workId: "run-3",
              ownerId,
              observedCursor: "0_0",
              status: "attempted",
            },
          }),
        ),
      )
    }

    // Operator attempts; loses to the very first pre-seeded claim.
    const outcome = await Effect.runPromise(
      processReadyWorkItem({
        streamUrl: url,
        ownerId: "owner-late",
        item: readyItem,
        handler: () => Effect.succeed("never"),
        claimId: "operator-claim",
      }),
    )
    expect(outcome.kind).toBe("claim-lost")
    if (outcome.kind === "claim-lost") {
      expect(outcome.winner.ownerId).toBe("owner-1")
    }

    // All four claims (3 pre-seeded + 1 operator) are present as evidence.
    const attempts = await Effect.runPromise(readRetainedClaimAttempts(url, "run-3"))
    expect(attempts).toHaveLength(4)
    expect(firstValidClaim("run-3", attempts)?.claimId).toBe("pre-owner-1")
  })
})

describe("claim-and-operator-authority — stale ready-work outcomes", () => {
  it("claim-and-operator-authority.OPERATOR_INVOCATION.12 — already-terminal returned without invoking handler", async () => {
    const { url, readyItem } = await seedReadyWork("already-terminal", "run-4", "c-4", "v")

    // Pre-terminalize the run so the operator observes a non-blocked current.
    const startedRun = startRun({ runId: "run-4" }).value as RunValue
    const completed = completeRun(startedRun, { result: "pre-terminalized" })
    const stream = await DurableStream.connect({ url })
    await stream.append(JSON.stringify(completed))

    let invoked = false
    const outcome = await Effect.runPromise(
      processReadyWorkItem({
        streamUrl: url,
        ownerId: "owner",
        item: readyItem,
        handler: () =>
          Effect.sync(() => {
            invoked = true
            return "x"
          }),
        claimId: "ours",
      }),
    )
    expect(outcome.kind).toBe("already-terminal")
    if (outcome.kind === "already-terminal") {
      expect(outcome.runState).toBe("completed")
    }
    expect(invoked).toBe(false)
  })

  it("claim-and-operator-authority.OPERATOR_INVOCATION.13 — terminalization-lost: handler ran, but a concurrent terminal arrived before our terminal append", async () => {
    const { url, readyItem } = await seedReadyWork("term-lost", "run-5", "c-5", "v")

    // Handler races: it writes a concurrent terminal record DURING execution
    // so the post-handler re-read observes a non-blocked run.
    const stream = await DurableStream.connect({ url })
    let invoked = false
    const outcome = await Effect.runPromise(
      processReadyWorkItem({
        streamUrl: url,
        ownerId: "owner",
        item: readyItem,
        handler: (input) =>
          Effect.tryPromise(async () => {
            invoked = true
            // Inject a concurrent terminal for this run while the handler is "executing".
            const startedRun = startRun({ runId: input.runId }).value as RunValue
            const concurrent = failRun(startedRun, { error: "concurrent-takeover" })
            await stream.append(JSON.stringify(concurrent))
            return "handler-result"
          }),
        claimId: "ours",
      }),
    )
    expect(invoked).toBe(true)
    expect(outcome.kind).toBe("terminalization-lost")
    if (outcome.kind === "terminalization-lost") {
      expect(outcome.terminalState).toBe("failed")
    }
  })
})

describe("claim-and-operator-authority — once-only terminalization (raw fold authority)", () => {
  it("claim-and-operator-authority.OPERATOR_INVOCATION.14 + RUN_TRANSITIONS.6/.7 — competing terminal records: raw foldRunRecords picks first; later terminals remain as evidence", async () => {
    const url = freshStreamUrl("once-only-terminal")
    const startedEvent = startRun({ runId: "run-T" })
    const startedRun = startedEvent.value as RunValue
    const firstTerminal = completeRun(startedRun, { result: "first-by-order" })
    const secondTerminal = failRun(startedRun, { error: "second-by-order" })
    const thirdTerminal = cancelRun(startedRun, { terminalReason: "third-by-order" })
    await publishToStream(url, [
      startedEvent,
      firstTerminal,
      secondTerminal,
      thirdTerminal,
    ])

    // RAW retained fold = AUTHORITY (RUN_TRANSITIONS.6).
    const records = await Effect.runPromise(readRetainedRunRecords(url, "run-T"))
    const authoritative = foldRunRecords("run-T", records)
    expect(authoritative?.state).toBe("completed")
    expect(authoritative?.result).toBe("first-by-order")

    // All three terminal records remain as evidence (RUN_TRANSITIONS.7 + CLAIM_ATTEMPT.4 spirit).
    expect(records.map((r) => r.state)).toEqual([
      "started",
      "completed",
      "failed",
      "cancelled",
    ])

    // StreamDB latest-state may DISAGREE with the authority — the spec acknowledges this.
    const snapshot = await rebuildProjection({ url })
    const latest = snapshot.runs.get("run-T")
    expect(latest?.state).toBe("cancelled") // last write wins in latest-state
    expect(latest?.state).not.toBe(authoritative?.state)
  })

  it("the operator's terminal append is the authoritative winner when no prior terminal exists", async () => {
    const { url, readyItem } = await seedReadyWork("operator-wins-terminal", "run-W", "c-W", "v")

    const outcome = await Effect.runPromise(
      processReadyWorkItem({
        streamUrl: url,
        ownerId: "owner",
        item: readyItem,
        handler: () => Effect.succeed({ via: "operator" }),
        claimId: "winner",
      }),
    )
    expect(outcome.kind).toBe("completed")

    const records = await Effect.runPromise(readRetainedRunRecords(url, "run-W"))
    const authoritative = foldRunRecords("run-W", records)
    expect(authoritative?.state).toBe("completed")
    expect(authoritative?.result).toEqual({ via: "operator" })
  })
})

describe("claim-and-operator-authority.OPERATOR_INVOCATION.15 — operator uses retained run-row authority, not StreamDB latest", () => {
  it("operator invokes/terminalizes when StreamDB latest shows terminal but the raw run fold says blocked (authority follows the fold)", async () => {
    const { url, readyItem } = await seedReadyWork("auth-disagree", "run-auth", "c-auth", "value")

    // Append a hand-rolled durable.run event whose `key` is the target runId
    // but whose `value.runId` field is a different id. StreamDB normalizes the
    // stored row''s key to the event key (so latest-state shows it under the
    // target runId with state=completed), but readRetainedRunRecords filters
    // by raw value.runId (which is "FAKE-ID") and skips it. Result:
    //   StreamDB latest for run-auth = "completed" (terminal)
    //   foldRunRecords  for run-auth = "blocked"   (last legitimate state)
    const stream = await DurableStream.connect({ url })
    await stream.append(
      JSON.stringify({
        type: "durable.run",
        key: "run-auth",
        value: {
          runId: "FAKE-ID",
          state: "completed",
          result: "phantom-terminal",
        },
        headers: { operation: "upsert" },
      }),
    )

    // Sanity: StreamDB latest for run-auth IS terminal.
    const latest = (await rebuildProjection({ url })).runs.get("run-auth")
    expect(latest?.state).toBe("completed")
    // But the authoritative raw fold is still blocked.
    const records = await Effect.runPromise(readRetainedRunRecords(url, "run-auth"))
    expect(foldRunRecords("run-auth", records)?.state).toBe("blocked")

    // Operator must follow the fold, NOT StreamDB latest. So it invokes the
    // handler and terminalizes normally — it must NOT return already-terminal.
    let invoked = false
    const outcome = await Effect.runPromise(
      processReadyWorkItem({
        streamUrl: url,
        ownerId: "owner-auth",
        item: readyItem,
        handler: () =>
          Effect.sync(() => {
            invoked = true
            return "real-result"
          }),
        claimId: "auth-claim",
      }),
    )
    expect(invoked).toBe(true)
    expect(outcome.kind).toBe("completed")

    // The legitimate terminal record was appended; the raw fold now agrees.
    const recordsAfter = await Effect.runPromise(
      readRetainedRunRecords(url, "run-auth"),
    )
    const authoritativeAfter = foldRunRecords("run-auth", recordsAfter)
    expect(authoritativeAfter?.state).toBe("completed")
    expect(authoritativeAfter?.result).toBe("real-result")
  })

  it("operator returns already-terminal when raw fold says terminal even if StreamDB latest disagrees (the inverse direction also follows fold)", async () => {
    const { url, readyItem } = await seedReadyWork("auth-other-direction", "run-x2", "c-x2", "v")

    // Append a legitimate terminal first (fold latches it as winner)...
    const startedRun = startRun({ runId: "run-x2" }).value as RunValue
    const completedEvent = completeRun(startedRun, { result: "first-terminal" })
    const stream = await DurableStream.connect({ url })
    await stream.append(JSON.stringify(completedEvent))
    // ...then a `blocked` upsert that StreamDB will treat as the latest.
    await stream.append(
      JSON.stringify(
        substrateState.runs.upsert({
          value: { runId: "run-x2", state: "blocked", blockedOnCompletionId: "c-x2" },
        }),
      ),
    )

    // StreamDB latest is "blocked" (last write wins) — looks like still active.
    const latest = (await rebuildProjection({ url })).runs.get("run-x2")
    expect(latest?.state).toBe("blocked")
    // But the raw fold authority is "completed" (first valid terminal).
    const records = await Effect.runPromise(readRetainedRunRecords(url, "run-x2"))
    expect(foldRunRecords("run-x2", records)?.state).toBe("completed")

    // Operator must return already-terminal even though StreamDB latest says blocked.
    let invoked = false
    const outcome = await Effect.runPromise(
      processReadyWorkItem({
        streamUrl: url,
        ownerId: "owner",
        item: readyItem,
        handler: () =>
          Effect.sync(() => {
            invoked = true
            return "should-not-run"
          }),
        claimId: "ours",
      }),
    )
    expect(outcome.kind).toBe("already-terminal")
    if (outcome.kind === "already-terminal") {
      expect(outcome.runState).toBe("completed")
    }
    expect(invoked).toBe(false)
  })
})

describe("claim-and-operator-authority — operator now uses raw retained fold for claim authority", () => {
  it("claim-and-operator-authority.CLAIM_AUTHORITY.7 — the operator's winner derivation is consistent with the raw retained claim fold", async () => {
    const { url, readyItem } = await seedReadyWork("op-uses-raw-fold", "run-K", "c-K", "v")

    // Pre-seed two earlier different-owner claims; operator becomes the third attempt.
    const stream = await DurableStream.connect({ url })
    for (const ownerId of ["alpha", "beta"]) {
      await stream.append(
        JSON.stringify(
          substrateState.claimAttempts.insert({
            value: {
              claimId: `pre-${ownerId}`,
              workId: "run-K",
              ownerId,
              observedCursor: "0_0",
              status: "attempted",
            },
          }),
        ),
      )
    }

    const outcome = await Effect.runPromise(
      processReadyWorkItem({
        streamUrl: url,
        ownerId: "operator",
        item: readyItem,
        handler: () => Effect.succeed("nope"),
        claimId: "operator-claim",
      }),
    )
    // Operator's loss matches the raw retained fold's winner.
    expect(outcome.kind).toBe("claim-lost")
    const attempts = await Effect.runPromise(readRetainedClaimAttempts(url, "run-K"))
    const winner = firstValidClaim("run-K", attempts)
    if (outcome.kind === "claim-lost") {
      expect(outcome.winner.claimId).toBe(winner?.claimId)
      expect(outcome.winner.ownerId).toBe("alpha")
    }
  })
})
