import { DurableStream } from "@durable-streams/client"
import type { ChangeEvent } from "@durable-streams/state"
import { Effect, Layer } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { processReadyWorkItem } from "../operator.ts"
import {
  CompletionProducer,
  SubstrateProducerLive,
  WorkProducer,
} from "../producer.ts"
import { deriveReadyWork } from "../ready-work.ts"
import { blockRun } from "../state-machine.ts"
import { rebuildProjection } from "../stream.ts"
import {
  DurableWaits,
  DurableWaitsLive,
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

// Test-level composition: append a state-machine event directly. Per Slice 8
// approval (option a), block-on-completion is not exposed through any public
// producer/runtime API; tests compose existing primitives.
async function appendEventToStream(url: string, event: ChangeEvent): Promise<void> {
  const stream = new DurableStream({ url, contentType: "application/json" })
  await stream.append(JSON.stringify(event))
}

const integratedLayer = (config: { streamUrl: string }) =>
  Layer.mergeAll(SubstrateProducerLive(config), DurableWaitsLive(config))

describe("implementation-sequencing.PHASES.8 — integrated substrate path (awakeable-driven happy path)", () => {
  it("declare -> awakeable -> block -> external resolve -> derive ready -> operator claims -> handler succeeds -> run.completed -> fresh rebuild proves terminal state", async () => {
    const url = await createSubstrateStream("integrated-happy")
    const layer = integratedLayer({ streamUrl: url })

    // Steps 1-2: declare work + create awakeable.
    const { runId, completionId, key } = await Effect.runPromise(
      Effect.gen(function* () {
        const wp = yield* WorkProducer
        const waits = yield* DurableWaits
        const declared = yield* wp.declareWork({ runId: "run-i" })
        const awk = yield* waits.awakeable({ workId: declared.runId, name: "approval" })
        return { runId: declared.runId, completionId: awk.completionId, key: awk.key }
      }).pipe(Effect.provide(layer)),
    )
    // implementation-sequencing.PHASES.9 — durable suspension is realized by
    // a durable.run row with state=blocked and blockedOnCompletionId. No
    // separate suspension/continuation row or API is used.
    expect(key).toBe("awk:work:run-i:approval")
    expect(completionId).toBe(key)

    // Step 3: block the run on the completion via TEST-LEVEL COMPOSITION
    // (state-machine builder + raw stream append). Not a public API.
    const preSnap = await rebuildProjection({ url })
    const startedRun = preSnap.runs.get(runId)!
    const blockedEvent = blockRun(startedRun, { blockedOnCompletionId: completionId })
    await appendEventToStream(url, blockedEvent)

    // Sanity: the run is now suspended per PHASES.9.
    const blockedSnap = await rebuildProjection({ url })
    expect(blockedSnap.runs.get(runId)?.state).toBe("blocked")
    expect(blockedSnap.runs.get(runId)?.blockedOnCompletionId).toBe(completionId)

    // Step 4: external resolution via existing CompletionProducer.
    await Effect.runPromise(
      Effect.gen(function* () {
        const cp = yield* CompletionProducer
        yield* cp.resolveCompletion({ completionId, result: { approved: true } })
      }).pipe(Effect.provide(layer)),
    )

    // Step 5: rebuild + derive ready.
    const readySnap = await rebuildProjection({ url })
    const readyProj = deriveReadyWork(readySnap)
    const readyItem = readyProj.readyWork.get(runId)
    expect(readyItem).toEqual({
      runId,
      completionId,
      result: { approved: true },
    })

    // Step 6 + 7: operator claims and invokes handler; handler success -> run.completed.
    const outcome = await Effect.runPromise(
      processReadyWorkItem({
        streamUrl: url,
        ownerId: "operator-i",
        item: readyItem!,
        handler: (input) =>
          Effect.succeed({ approvedResult: (input.result as { approved: boolean }).approved }),
      }),
    )
    expect(outcome.kind).toBe("completed")
    if (outcome.kind === "completed") {
      expect(outcome.result).toEqual({ approvedResult: true })
    }

    // Step 8: rebuild from zero (fresh rebuildProjection consumer) proves the
    // terminal state survives without any in-process memory.
    const finalSnap = await rebuildProjection({ url })
    const finalRun = finalSnap.runs.get(runId)
    expect(finalRun?.state).toBe("completed")
    expect(finalRun?.result).toEqual({ approvedResult: true })
    expect(finalSnap.completions.get(completionId)?.state).toBe("resolved")
  })
})

describe("implementation-sequencing.PHASES.8 — integrated path Variant A (handler failure)", () => {
  it("handler fails in the Effect error channel -> integrated path produces run.failed", async () => {
    const url = await createSubstrateStream("integrated-failure")
    const layer = integratedLayer({ streamUrl: url })

    const { runId, completionId } = await Effect.runPromise(
      Effect.gen(function* () {
        const wp = yield* WorkProducer
        const waits = yield* DurableWaits
        const declared = yield* wp.declareWork({ runId: "run-f" })
        const awk = yield* waits.awakeable({ workId: declared.runId, name: "external" })
        return { runId: declared.runId, completionId: awk.completionId }
      }).pipe(Effect.provide(layer)),
    )

    const startedSnap = await rebuildProjection({ url })
    const startedRun = startedSnap.runs.get(runId)!
    await appendEventToStream(url, blockRun(startedRun, { blockedOnCompletionId: completionId }))

    await Effect.runPromise(
      Effect.gen(function* () {
        const cp = yield* CompletionProducer
        yield* cp.resolveCompletion({ completionId, result: "input" })
      }).pipe(Effect.provide(layer)),
    )

    const readyItem = deriveReadyWork(await rebuildProjection({ url })).readyWork.get(runId)!
    const outcome = await Effect.runPromise(
      processReadyWorkItem({
        streamUrl: url,
        ownerId: "operator",
        item: readyItem,
        handler: () => Effect.fail({ code: "HANDLER_BOOM" }),
      }),
    )
    expect(outcome.kind).toBe("failed")
    if (outcome.kind === "failed") {
      expect(outcome.error).toEqual({ code: "HANDLER_BOOM" })
    }

    const finalSnap = await rebuildProjection({ url })
    const finalRun = finalSnap.runs.get(runId)
    expect(finalRun?.state).toBe("failed")
    expect(finalRun?.error).toEqual({ code: "HANDLER_BOOM" })
  })
})

describe("implementation-sequencing.PHASES.8 — integrated path Variant B (uniform completion-kind rehearsal)", () => {
  it("a sleep-completion makes a blocked run ready and the operator completes it (lifecycle uniform with awakeable)", async () => {
    const url = await createSubstrateStream("integrated-sleep")
    const layer = integratedLayer({ streamUrl: url })

    const { runId, completionId } = await Effect.runPromise(
      Effect.gen(function* () {
        const wp = yield* WorkProducer
        const waits = yield* DurableWaits
        const declared = yield* wp.declareWork({ runId: "run-sleep" })
        const sleep = yield* waits.sleep({ durationMs: 1 })
        return { runId: declared.runId, completionId: sleep.completionId }
      }).pipe(Effect.provide(layer)),
    )

    // Block the run on the timer completion.
    const startedSnap = await rebuildProjection({ url })
    const startedRun = startedSnap.runs.get(runId)!
    await appendEventToStream(url, blockRun(startedRun, { blockedOnCompletionId: completionId }))

    // Manually resolve the timer (Slice 7 has no timer resolver — that's fine).
    await Effect.runPromise(
      Effect.gen(function* () {
        const cp = yield* CompletionProducer
        yield* cp.resolveCompletion({ completionId, result: { firedAtMs: 9999 } })
      }).pipe(Effect.provide(layer)),
    )

    const readyItem = deriveReadyWork(await rebuildProjection({ url })).readyWork.get(runId)
    expect(readyItem).toBeDefined()
    expect(readyItem?.result).toEqual({ firedAtMs: 9999 })

    const outcome = await Effect.runPromise(
      processReadyWorkItem({
        streamUrl: url,
        ownerId: "operator",
        item: readyItem!,
        handler: () => Effect.succeed("after-sleep"),
      }),
    )
    expect(outcome.kind).toBe("completed")

    const finalRun = (await rebuildProjection({ url })).runs.get(runId)
    expect(finalRun?.state).toBe("completed")
    expect(finalRun?.result).toBe("after-sleep")
  })

  it("a scheduled_work completion makes a blocked run ready and the operator completes it (lifecycle uniform with awakeable)", async () => {
    const url = await createSubstrateStream("integrated-scheduled-work")
    const layer = integratedLayer({ streamUrl: url })

    const { runId, completionId } = await Effect.runPromise(
      Effect.gen(function* () {
        const wp = yield* WorkProducer
        const waits = yield* DurableWaits
        const declared = yield* wp.declareWork({ runId: "run-sch" })
        const sched = yield* waits.scheduleWork({
          whenMs: 0,
          input: { task: "rehearsal" },
          workId: declared.runId,
        })
        return { runId: declared.runId, completionId: sched.completionId }
      }).pipe(Effect.provide(layer)),
    )

    const startedSnap = await rebuildProjection({ url })
    const startedRun = startedSnap.runs.get(runId)!
    await appendEventToStream(url, blockRun(startedRun, { blockedOnCompletionId: completionId }))

    await Effect.runPromise(
      Effect.gen(function* () {
        const cp = yield* CompletionProducer
        yield* cp.resolveCompletion({
          completionId,
          result: { firedTask: "rehearsal-completed" },
        })
      }).pipe(Effect.provide(layer)),
    )

    const readyItem = deriveReadyWork(await rebuildProjection({ url })).readyWork.get(runId)
    expect(readyItem?.result).toEqual({ firedTask: "rehearsal-completed" })

    const outcome = await Effect.runPromise(
      processReadyWorkItem({
        streamUrl: url,
        ownerId: "operator",
        item: readyItem!,
        handler: (input) => Effect.succeed(input.result),
      }),
    )
    expect(outcome.kind).toBe("completed")

    const finalRun = (await rebuildProjection({ url })).runs.get(runId)
    expect(finalRun?.state).toBe("completed")
    expect(finalRun?.result).toEqual({ firedTask: "rehearsal-completed" })
  })
})
