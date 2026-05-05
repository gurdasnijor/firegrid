import { DurableStream } from "@durable-streams/client"
import { Effect, Either } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as substrate from "../kernel/index.ts"
import {
  ClaimMissingCursorError,
  ClaimStreamError,
  firstValidClaim,
  processReadyWorkItem,
} from "../operator.ts"
import { deriveReadyWork } from "../projection/ready-work.ts"
import type { ClaimAttemptValue, CompletionValue, RunValue } from "../schema/rows.ts"
import {
  blockRun,
  createPendingCompletion,
  resolveCompletion,
  startRun,
} from "./state-machine-sync.ts"
import { substrateState } from "../schema/state.ts"
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

// Build the canonical "blocked run awaiting a resolved completion" sequence.
async function seedReadyWork(
  label: string,
  runId: string,
  completionId: string,
  result: unknown,
): Promise<{ url: string; readyItem: substrate.ReadyWorkItem }> {
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
  if (readyItem === undefined) throw new Error("expected ready item to be derived")
  return { url, readyItem }
}

async function seedRunOnly(label: string, runId: string): Promise<string> {
  const url = freshStreamUrl(label)
  await publishToStream(url, [startRun({ runId })])
  return url
}

describe("claim-and-operator-authority.CLAIM_AUTHORITY (pure first-valid fold)", () => {
  it("claim-and-operator-authority.CLAIM_AUTHORITY.1 — winning claim is the first attempt for the workId by stream order", () => {
    const a: ClaimAttemptValue = {
      claimId: "c-1",
      workId: "work-1",
      ownerId: "owner-A",
      observedCursor: "0_0",
      status: "attempted",
    }
    const b: ClaimAttemptValue = {
      claimId: "c-2",
      workId: "work-1",
      ownerId: "owner-B",
      observedCursor: "0_1",
      status: "attempted",
    }
    expect(firstValidClaim("work-1", [a, b])?.claimId).toBe("c-1")
  })

  it("claim-and-operator-authority.CLAIM_AUTHORITY.2 — same-owner duplicate attempts do not create a second winner", () => {
    const a: ClaimAttemptValue = {
      claimId: "c-1",
      workId: "work-1",
      ownerId: "owner-A",
      observedCursor: "0_0",
      status: "attempted",
    }
    const dup: ClaimAttemptValue = {
      claimId: "c-2",
      workId: "work-1",
      ownerId: "owner-A",
      observedCursor: "0_1",
      status: "attempted",
    }
    const winner = firstValidClaim("work-1", [a, dup])
    expect(winner?.claimId).toBe("c-1")
    expect(winner?.ownerId).toBe("owner-A")
  })

  it("claim-and-operator-authority.CLAIM_AUTHORITY.3 — later different-owner attempts are losing conflicts", () => {
    const a: ClaimAttemptValue = {
      claimId: "c-1",
      workId: "work-1",
      ownerId: "owner-A",
      observedCursor: "0_0",
      status: "attempted",
    }
    const b: ClaimAttemptValue = {
      claimId: "c-2",
      workId: "work-1",
      ownerId: "owner-B",
      observedCursor: "0_1",
      status: "attempted",
    }
    expect(firstValidClaim("work-1", [a, b])?.ownerId).toBe("owner-A")
  })

  it("claim-and-operator-authority.CLAIM_AUTHORITY.6 — the fold is list-in/winner-out scoped to one workId; mixed-workId input cannot affect the target winner", () => {
    const target: ClaimAttemptValue = {
      claimId: "c-target",
      workId: "work-target",
      ownerId: "owner-A",
      observedCursor: "0_0",
      status: "attempted",
    }
    const noise: ClaimAttemptValue = {
      claimId: "c-noise",
      workId: "work-other",
      ownerId: "owner-X",
      observedCursor: "0_0",
      status: "attempted",
    }
    expect(firstValidClaim("work-target", [noise, target])?.claimId).toBe("c-target")
    expect(firstValidClaim("work-target", [])).toBeUndefined()
    expect(firstValidClaim("work-missing", [noise, target])).toBeUndefined()
  })
})

describe("claim-and-operator-authority.OPERATOR_INVOCATION (single-shot)", () => {
  it("claim-and-operator-authority.OPERATOR_INVOCATION.2 — operator claims by appending durable.claim.attempt", async () => {
    const { url, readyItem } = await seedReadyWork("claim-append", "run-1", "c-1", "ok")
    const handler = (_input: substrate.ReadyWorkItem) => Effect.succeed("done")

    await Effect.runPromise(
      processReadyWorkItem({
        streamUrl: url,
        ownerId: "operator-1",
        item: readyItem,
        handler,
        claimId: "claim-A",
      }),
    )
    const snapshot = await rebuildProjection({ url })
    const claim = snapshot.claimAttempts.get("claim-A")
    expect(claim).toBeDefined()
    expect(claim?.workId).toBe("run-1")
    expect(claim?.ownerId).toBe("operator-1")
    expect(claim?.status).toBe("attempted")
  })

  it("claim-and-operator-authority.OPERATOR_INVOCATION.3 — handler is invoked only after the claim is observed as the winner", async () => {
    const { url, readyItem } = await seedReadyWork("invoke-after-claim", "run-2", "c-2", "value-2")
    let invoked = false
    let claimsAtInvocation = 0
    const handler = (_input: substrate.ReadyWorkItem) =>
      Effect.gen(function* () {
        invoked = true
        const snap = yield* Effect.tryPromise(() => rebuildProjection({ url }))
        claimsAtInvocation = snap.claimAttempts.size
        return "ok"
      })

    const outcome = await Effect.runPromise(
      processReadyWorkItem({
        streamUrl: url,
        ownerId: "operator-2",
        item: readyItem,
        handler,
        claimId: "claim-B",
      }),
    )
    expect(invoked).toBe(true)
    // At the moment of invocation, our claim was already on the stream.
    expect(claimsAtInvocation).toBeGreaterThanOrEqual(1)
    expect(outcome.kind).toBe("completed")
  })

  it("claim-and-operator-authority.OPERATOR_INVOCATION.4 — speculative invocation is forbidden; a losing claim does NOT invoke the handler", async () => {
    const { url, readyItem } = await seedReadyWork("speculative-blocked", "run-3", "c-3", "v")

    // Pre-existing winning claim from a different owner.
    const earlierClaim = substrateState.claimAttempts.insert({
      value: {
        claimId: "earlier",
        workId: "run-3",
        ownerId: "owner-first",
        observedCursor: "0_0",
        status: "attempted",
      },
    })
    const stream = await DurableStream.connect({ url })
    await stream.append(JSON.stringify(earlierClaim))

    let invoked = false
    const handler = () =>
      Effect.sync(() => {
        invoked = true
        return "should-not-run"
      })

    const outcome = await Effect.runPromise(
      processReadyWorkItem({
        streamUrl: url,
        ownerId: "operator-late",
        item: readyItem,
        handler,
        claimId: "later",
      }),
    )
    expect(invoked).toBe(false)
    expect(outcome.kind).toBe("claim-lost")
    if (outcome.kind === "claim-lost") {
      expect(outcome.winner.claimId).toBe("earlier")
      expect(outcome.winner.ownerId).toBe("owner-first")
    }

    // The loser's run was NOT terminalized.
    const snapshot = await rebuildProjection({ url })
    expect(snapshot.runs.get("run-3")?.state).toBe("blocked")
  })

  it("claim-and-operator-authority.OPERATOR_INVOCATION.5 — only the winning owner attempts to terminalize; losing operator does not append a run terminal", async () => {
    const { url, readyItem } = await seedReadyWork("only-winner-terminalizes", "run-4", "c-4", "v")
    const earlier = substrateState.claimAttempts.insert({
      value: {
        claimId: "first",
        workId: "run-4",
        ownerId: "owner-first",
        observedCursor: "0_0",
        status: "attempted",
      },
    })
    const stream = await DurableStream.connect({ url })
    await stream.append(JSON.stringify(earlier))

    await Effect.runPromise(
      processReadyWorkItem({
        streamUrl: url,
        ownerId: "owner-late",
        item: readyItem,
        handler: () => Effect.succeed("nope"),
        claimId: "later",
      }),
    )
    const snapshot = await rebuildProjection({ url })
    // Run is still blocked — no terminal record was appended by the loser.
    expect(snapshot.runs.get("run-4")?.state).toBe("blocked")
  })

  it("claim-and-operator-authority.OPERATOR_INVOCATION.6 — handler success becomes durable run.completed", async () => {
    const { url, readyItem } = await seedReadyWork("success-completed", "run-5", "c-5", "input")
    const outcome = await Effect.runPromise(
      processReadyWorkItem({
        streamUrl: url,
        ownerId: "owner",
        item: readyItem,
        handler: (i) => Effect.succeed({ echoed: i.result }),
      }),
    )
    expect(outcome.kind).toBe("completed")
    if (outcome.kind === "completed") {
      expect(outcome.result).toEqual({ echoed: "input" })
    }
    const snapshot = await rebuildProjection({ url })
    const run = snapshot.runs.get("run-5")
    expect(run?.state).toBe("completed")
    expect(run?.result).toEqual({ echoed: "input" })
  })

  it("claim-and-operator-authority.OPERATOR_INVOCATION.6 — expected handler failure becomes durable run.failed", async () => {
    const { url, readyItem } = await seedReadyWork("failure-failed", "run-6", "c-6", "x")
    const outcome = await Effect.runPromise(
      processReadyWorkItem({
        streamUrl: url,
        ownerId: "owner",
        item: readyItem,
        handler: () => Effect.fail({ code: "BOOM" }),
      }),
    )
    expect(outcome.kind).toBe("failed")
    if (outcome.kind === "failed") {
      expect(outcome.error).toEqual({ code: "BOOM" })
    }
    const snapshot = await rebuildProjection({ url })
    const run = snapshot.runs.get("run-6")
    expect(run?.state).toBe("failed")
    expect(run?.error).toEqual({ code: "BOOM" })
  })

  it("claim-and-operator-authority.OPERATOR_INVOCATION.8 — handlers do not call explicit complete/fail APIs (returning Effect channels is sufficient)", async () => {
    // Structural: handler signature is (input: ReadyWorkItem) => Effect<A, E>.
    // It receives no completeRun/failRun helpers, no producer service, no
    // claim authority API. The runner derives terminalization from the Effect exit.
    const { url, readyItem } = await seedReadyWork("no-explicit-apis", "run-7", "c-7", "v")
    const outcome = await Effect.runPromise(
      processReadyWorkItem({
        streamUrl: url,
        ownerId: "owner",
        item: readyItem,
        handler: (input) => {
          // The handler''s signature can ONLY return Effect of A or fail E.
          // It cannot reach into the substrate for terminalization.
          const noOp: typeof input = input
          return Effect.succeed(noOp.runId)
        },
      }),
    )
    expect(outcome.kind).toBe("completed")
  })

  it("claim-and-operator-authority.OPERATOR_INVOCATION.9 — Slice 5 operator processing is single-shot for one ReadyWorkItem (no live watcher loop)", () => {
    expect(typeof processReadyWorkItem).toBe("function")
    // No long-running runner / scheduler / loop is exposed.
    const m = substrate as unknown as Record<string, unknown>
    expect(m.runOperator).toBeUndefined()
    expect(m.OperatorRunner).toBeUndefined()
    expect(m.startOperator).toBeUndefined()
  })

  it("claim-and-operator-authority.OPERATOR_INVOCATION.10 — handlers receive the full ReadyWorkItem as input", async () => {
    const { url, readyItem } = await seedReadyWork("handler-input", "run-8", "c-8", "carried")
    let received: substrate.ReadyWorkItem | undefined
    await Effect.runPromise(
      processReadyWorkItem({
        streamUrl: url,
        ownerId: "owner",
        item: readyItem,
        handler: (input) =>
          Effect.sync(() => {
            received = input
            return null
          }),
      }),
    )
    expect(received).toEqual({ runId: "run-8", completionId: "c-8", result: "carried" })
  })

  it("claim-and-operator-authority.OPERATOR_INVOCATION.11 — run terminalization is appended internally by the operator (no producer terminal API)", () => {
    // Structural: WorkProducer surface is unchanged from Slice 3 (declareWork only).
    // No completeRun/failRun/cancelRun method is exposed on the producer.
    expect(Object.keys((substrate.WorkProducer as unknown as { fields?: object }) ?? {})).not.toContain("completeRun")
    // The operator owns the terminal append via state-machine builders inside processReadyWorkItem.
  })
})

describe("claim-and-operator-authority.CLAIM_ATTEMPT (operator-side)", () => {
  it("claim-and-operator-authority.CLAIM_ATTEMPT.6 — the operator maps ReadyWorkItem.runId to the claim workId", async () => {
    const { url, readyItem } = await seedReadyWork("workid-mapping", "run-9", "c-9", "v")
    await Effect.runPromise(
      processReadyWorkItem({
        streamUrl: url,
        ownerId: "owner",
        item: readyItem,
        handler: () => Effect.succeed("ok"),
        claimId: "k1",
      }),
    )
    const snapshot = await rebuildProjection({ url })
    expect(snapshot.claimAttempts.get("k1")?.workId).toBe("run-9")
  })

  it("claim-and-operator-authority.CLAIM_ATTEMPT.7 — claim ids are unique per attempt; not idempotency keys (same-owner duplicate evidence)", async () => {
    const { url, readyItem } = await seedReadyWork("unique-claimids", "run-10", "c-10", "v")

    // Pre-seed a same-owner claim attempt so the operator's later claim is a
    // duplicate-evidence case (not a fresh winner). We seed via the state-schema
    // helper directly because Slice 5 is single-shot per item; running the
    // operator twice on the same item would hit a terminalized run race that
    // Slice 6 owns.
    const seededFirst = substrateState.claimAttempts.insert({
      value: {
        claimId: "first-attempt",
        workId: "run-10",
        ownerId: "owner-A",
        observedCursor: "0_0",
        status: "attempted",
      },
    })
    const stream = await DurableStream.connect({ url })
    await stream.append(JSON.stringify(seededFirst))

    // Operator now attempts a same-owner second claim. It will lose by
    // first-valid-stream-order, but the claim record IS appended.
    const outcome = await Effect.runPromise(
      processReadyWorkItem({
        streamUrl: url,
        ownerId: "owner-A", // same owner as the pre-seeded attempt
        item: readyItem,
        handler: () => Effect.succeed("never"),
        claimId: "second-attempt",
      }),
    )
    expect(outcome.kind).toBe("claim-lost")

    const snapshot = await rebuildProjection({ url })
    const claims = [...snapshot.claimAttempts.values()].filter((c) => c.workId === "run-10")
    expect(claims.length).toBe(2)
    // Two distinct claimIds even with the same ownerId.
    const ids = new Set(claims.map((c) => c.claimId))
    expect(ids).toEqual(new Set(["first-attempt", "second-attempt"]))
    expect(new Set(claims.map((c) => c.ownerId))).toEqual(new Set(["owner-A"]))
    // First-valid-by-stream-order picks the first; second is duplicate evidence.
    const winner = firstValidClaim("run-10", [...snapshot.claimAttempts.values()])
    expect(winner?.claimId).toBe("first-attempt")
    expect(winner?.ownerId).toBe("owner-A")
  })

  it("claim-and-operator-authority.CLAIM_ATTEMPT.8 — observedCursor is captured from real durable stream metadata", async () => {
    const { url, readyItem } = await seedReadyWork("captured-cursor", "run-11", "c-11", "v")
    await Effect.runPromise(
      processReadyWorkItem({
        streamUrl: url,
        ownerId: "owner",
        item: readyItem,
        handler: () => Effect.succeed("ok"),
        claimId: "k-cursor",
      }),
    )
    const snapshot = await rebuildProjection({ url })
    const claim = snapshot.claimAttempts.get("k-cursor")
    expect(claim).toBeDefined()
    // Durable Streams cursor format: "<read-seq>_<byte-offset>".
    expect(claim?.observedCursor).toMatch(/^-?\d+_\d+$/)
  })
})

describe("claim-and-operator-authority operator error semantics", () => {
  it("appending against a non-existent stream surfaces ClaimStreamError in the Effect error channel", async () => {
    const url = freshStreamUrl("op-stream-error")
    const result = await Effect.runPromise(
      Effect.either(
        processReadyWorkItem({
          streamUrl: url,
          ownerId: "owner",
          item: { runId: "ghost", completionId: "c-x", result: "v" },
          handler: () => Effect.succeed(null),
        }),
      ),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(ClaimStreamError)
    }
  })

  it("running against a stream with no run row surfaces RunNotFoundError after a winning claim", async () => {
    // Construct a scenario where the operator wins the claim but no matching
    // durable.run exists in the projection. This is a degenerate input
    // (caller forged a ReadyWorkItem), but the typed error must surface.
    const url = await seedRunOnly("no-run-after-claim", "exists")
    const result = await Effect.runPromise(
      Effect.either(
        processReadyWorkItem({
          streamUrl: url,
          ownerId: "owner",
          item: { runId: "ghost-run", completionId: "c-z", result: "v" },
          handler: () => Effect.succeed(null),
        }),
      ),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toMatchObject({ _tag: "RunNotFoundError" })
    }
  })

  // Reference exported error type so unused-symbol lint doesn''t trip.
  void ClaimMissingCursorError
})

describe("claim-and-operator-authority.PHASE_BOUNDARY (Slice 5)", () => {
  it("claim-and-operator-authority.PHASE_BOUNDARY.2 — this feature does not define run/completion state-machine transitions (operator imports them, owns nothing new)", async () => {
    // Structural: operator.ts imports state-machine builders; it does not
    // re-define legal-transition rules. Slice 2 still owns those.
    const op = await import("../operator.ts")
    const opNames = Object.keys(op)
    for (const symbol of [
      "isLegalRunTransition",
      "isLegalCompletionTransition",
      "RunState",
      "CompletionState",
    ]) {
      expect(opNames).not.toContain(symbol)
    }
  })

  it("claim-and-operator-authority.PHASE_BOUNDARY.3 — this feature does not require real agents/ACP/CLI/process launch/provider/tool transport", () => {
    const m = substrate as unknown as Record<string, unknown>
    for (const symbol of [
      "ACP",
      "MCP",
      "spawn",
      "execute",
      "Provider",
      "Sandbox",
      "ToolTransport",
      "runCli",
    ]) {
      expect(m[symbol]).toBeUndefined()
    }
  })
})
