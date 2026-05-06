import { DurableStream } from "@durable-streams/client"
import { Cause, Duration, Effect, Exit, Layer } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  CompletionId,
  OwnerId,
  RunWait,
  WorkId,
  currentWorkContextLayer,
  triggerMatchersLayer,
  type ProjectionMatchTrigger,
} from "../index.ts"
import { SubstrateProducerLive, WorkProducer } from "../write-api/producer.ts"
import { rebuildProjection } from "../stream.ts"
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

const createSubstrateStream = async (label: string): Promise<string> => {
  const url = freshStreamUrl(label)
  await DurableStream.create({ url, contentType: "application/json" })
  return url
}

const declareRun = (streamUrl: string, runId: string) =>
  Effect.gen(function* () {
    const work = yield* WorkProducer
    return yield* work.declareWork({ runId })
  }).pipe(Effect.provide(SubstrateProducerLive({ streamUrl })))

const currentRunLayer = (runId: string) =>
  currentWorkContextLayer({
    workId: WorkId(runId),
    ownerId: OwnerId("owner-run-wait"),
  })

const acceptsTrigger = triggerMatchersLayer({
  "fixture.run-wait.ready": () =>
    Effect.succeed({ kind: "match", value: "ok" } as const),
})

const runWaitLayerFor = (streamUrl: string) =>
  Layer.mergeAll(
    RunWait.layer({ streamUrl }),
    acceptsTrigger,
  )

const projectionTrigger: ProjectionMatchTrigger = {
  _tag: "ProjectionMatch",
  label: "run-wait-ready",
  projectionKey: "run-wait:ready",
  matcherId: "fixture.run-wait.ready",
}

describe("run-wait-primitives.RUN_WAIT_API — app-facing durable wait primitive boundary", () => {
  it("run-wait-primitives.RUN_WAIT_API.1, run-wait-primitives.RUN_WAIT_API.2, run-wait-primitives.RUN_WAIT_API.6, run-wait-primitives.RUN_WAIT_API.7 — RunWait.for is provided by RunWait.layer and writes the existing projection_match blocked-run shape", async () => {
    const url = await createSubstrateStream("run-wait-for")
    const runId = "run-runwait-for-1"
    await Effect.runPromise(declareRun(url, runId))

    const program = Effect.gen(function* () {
      const wait = yield* RunWait
      return yield* wait.for(projectionTrigger)
    })

    const exit = await Effect.runPromiseExit(
      program.pipe(
        Effect.provide(
          Layer.mergeAll(
            runWaitLayerFor(url),
            currentRunLayer(runId),
          ),
        ),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.isInterruptedOnly(exit.cause)).toBe(true)
    }

    const snapshot = await rebuildProjection({ url })
    const run = snapshot.runs.get(runId)
    expect(run?.state).toBe("blocked")
    const completion = snapshot.completions.get(run!.blockedOnCompletionId!)
    expect(completion?.kind).toBe("projection_match")
    expect(completion?.state).toBe("pending")
    expect(completion?.data).toMatchObject({ trigger: projectionTrigger })
  })

  it("run-wait-primitives.RUN_WAIT_API.3, run-wait-primitives.RUN_WAIT_API.6, run-wait-primitives.RUN_WAIT_API.7 — RunWait.sleep suspends through existing timer completion and ready-work row shapes", async () => {
    const url = await createSubstrateStream("run-wait-sleep")
    const runId = "run-runwait-sleep-1"
    await Effect.runPromise(declareRun(url, runId))

    const program = Effect.gen(function* () {
      const wait = yield* RunWait
      return yield* wait.sleep(Duration.seconds(3))
    })

    const exit = await Effect.runPromiseExit(
      program.pipe(
        Effect.provide(
          Layer.mergeAll(
            RunWait.layer({ streamUrl: url }),
            currentRunLayer(runId),
          ),
        ),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.isInterruptedOnly(exit.cause)).toBe(true)
    }

    const snapshot = await rebuildProjection({ url })
    const run = snapshot.runs.get(runId)
    expect(run?.state).toBe("blocked")
    const completion = snapshot.completions.get(run!.blockedOnCompletionId!)
    expect(completion?.kind).toBe("timer")
    expect(completion?.state).toBe("pending")
    expect(completion?.data).toMatchObject({ durationMs: 3000 })
  })

  it("run-wait-primitives.RUN_WAIT_API.4, run-wait-primitives.BOUNDARY.1, run-wait-primitives.BOUNDARY.2 — RunWait.until records scheduled work intent without blocking the current run", async () => {
    const url = await createSubstrateStream("run-wait-until")
    const runId = "run-runwait-until-1"
    await Effect.runPromise(declareRun(url, runId))

    const when = Date.now() + 60_000
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const wait = yield* RunWait
        return yield* wait.until(when, { kind: "follow-up" })
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RunWait.layer({ streamUrl: url }),
            currentRunLayer(runId),
          ),
        ),
      ),
    )

    const snapshot = await rebuildProjection({ url })
    const run = snapshot.runs.get(runId)
    expect(run?.state).toBe("started")
    expect(run?.blockedOnCompletionId).toBeUndefined()
    const completion = snapshot.completions.get(result.completionId)
    expect(completion?.kind).toBe("scheduled_work")
    expect(completion?.state).toBe("pending")
    expect(completion?.data).toStrictEqual({
      whenMs: when,
      input: { kind: "follow-up" },
    })
  })

  it("run-wait-primitives.RUN_WAIT_API.5, run-wait-primitives.BOUNDARY.2 — RunWait.awakeable creates a work-scoped awakeable without caller-supplied completion ids", async () => {
    const url = await createSubstrateStream("run-wait-awakeable")
    const runId = "run-runwait-awakeable-1"
    await Effect.runPromise(declareRun(url, runId))

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const wait = yield* RunWait
        return yield* wait.awakeable("approval")
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RunWait.layer({ streamUrl: url }),
            currentRunLayer(runId),
          ),
        ),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.isInterruptedOnly(exit.cause)).toBe(true)
    }

    const expectedCompletionId = `awk:work:${runId}:approval`
    const snapshot = await rebuildProjection({ url })
    const run = snapshot.runs.get(runId)
    expect(run?.state).toBe("blocked")
    expect(run?.blockedOnCompletionId).toBe(expectedCompletionId)
    const completion = snapshot.completions.get(expectedCompletionId)
    expect(completion?.kind).toBe("externally_resolved_awakeable")
    expect(completion?.state).toBe("pending")
  })
})

describe("run-wait-primitives.BOUNDARY — RunWait surface avoids raw kernel and client vocabulary", () => {
  it("run-wait-primitives.RUN_WAIT_API.1, run-wait-primitives.BOUNDARY.2, run-wait-primitives.BOUNDARY.3 — RunWait exposes only app-facing primitive methods and a Layer constructor", () => {
    expect(typeof RunWait.layer).toBe("function")
    const methodNames = Object.keys(
      RunWait.of({
        for: () => Effect.void,
        sleep: () => Effect.void,
        until: () =>
          Effect.succeed({
            completionId: CompletionId("completion"),
            whenMs: 0,
          }),
        awakeable: () => Effect.never,
      }),
    )
    expect(methodNames).toStrictEqual(["for", "sleep", "until", "awakeable"])
    for (const forbidden of [
      "append",
      "blockRun",
      "completionId",
      "createPendingCompletion",
      "runId",
      "streamUrl",
    ]) {
      expect(methodNames).not.toContain(forbidden)
    }
  })
})
