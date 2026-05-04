import { DurableStream } from "@durable-streams/client"
import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Ref,
  Stream,
} from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  Projection,
  ProjectionLive,
  type ProjectionQuery,
} from "../facade/projection.js"
import {
  Work,
  WorkClaim,
  WorkClaimLive,
  type ClaimAttemptOutcome,
  type WorkClaimError,
} from "../facade/work.js"
import { deriveReadyWork, type ReadyWorkItem } from "../ready-work.js"
import {
  blockRun,
  completeRun,
  createPendingCompletion,
  failRun,
  resolveCompletion,
  startRun,
} from "../state-machine.js"
import type { CompletionValue, RunValue } from "../rows.js"
import { rebuildProjection } from "../stream.js"
import {
  freshStreamUrl,
  publishToStream,
  startTestServer,
  stopTestServer,
} from "./helpers.js"

beforeAll(async () => {
  await startTestServer()
})

afterAll(async () => {
  await stopTestServer()
})

// Test-only kernel run recorder. Maps (ReadyWorkItem, Exit) -> run terminal
// row append via state-machine builders. Lives here (not exported from the
// substrate facade) per facade design: recordOutcome takes a domain
// recorder; substrate ships no public KernelRunRecorder.
const kernelRunRecorder =
  (streamUrl: string) =>
  (item: ReadyWorkItem, exit: Exit.Exit<unknown, unknown>) =>
    Effect.gen(function* () {
      const snap = yield* Effect.tryPromise(() => rebuildProjection({ url: streamUrl }))
      const run = snap.runs.get(item.runId)
      if (run === undefined) return yield* Effect.die(`run ${item.runId} not found`)
      const stream = new DurableStream({ url: streamUrl, contentType: "application/json" })
      const event = Exit.match(exit, {
        onSuccess: (result) => completeRun(run, { result }),
        onFailure: (cause) =>
          failRun(run, { error: Cause.squash(cause) ?? "interrupted" }),
      })
      yield* Effect.tryPromise(() => stream.append(JSON.stringify(event)))
    })

// Seed: declare run, declare pending completion, block run, resolve completion.
async function seedReadyRun(
  label: string,
  runId: string,
  completionId: string,
  result: unknown,
): Promise<string> {
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
  return url
}

const readyWorkQuery: ProjectionQuery<ReadonlyArray<ReadyWorkItem>> = {
  label: "readyWork",
  evaluate: (snap) => Effect.succeed(Array.from(deriveReadyWork(snap).readyWork.values())),
}

// ergonomic-facade.CLAIMED_WORK_API.1, .2, .3, .4, .5, .6, .7, .9, .10
// effect-native-api.OPERATOR_PROGRAMS.1, .2, .7, .10, .11
describe("ergonomic-facade.COMMON_USAGE_EXAMPLES.3 — launch dispatch via the Work pipeline (success path)", () => {
  it("Projection.stream + Work.claimedBy + Work.perform + Work.recordOutcome + Work.runScoped advances a blocked run to completed", async () => {
    const runId = "run-launch-1"
    const completionId = "cmp-launch-1"
    const url = await seedReadyRun("facade-launch-success", runId, completionId, {
      payload: { agent: "a-1" },
    })

    const program = Effect.scoped(
      Effect.gen(function* () {
        const projection = yield* Projection
        yield* Work.runScoped(
          projection.stream(readyWorkQuery).pipe(
            Stream.flatMap((items) => Stream.fromIterable(items)),
            Work.claimedBy<ReadyWorkItem>("operator-A", (i) => i.runId),
            Work.perform((item) =>
              Effect.succeed({ launched: true, source: item.result }),
            ),
            Work.recordOutcome(kernelRunRecorder(url)),
            Stream.take(1),
          ),
        )
      }),
    )

    await Effect.runPromise(
      program.pipe(
        Effect.provide(ProjectionLive({ streamUrl: url })),
        Effect.provide(WorkClaimLive({ streamUrl: url })),
      ),
    )

    const finalSnap = await rebuildProjection({ url })
    const finalRun = finalSnap.runs.get(runId)
    expect(finalRun?.state).toBe("completed")
    expect(finalRun?.result).toEqual({
      launched: true,
      source: { payload: { agent: "a-1" } },
    })
  })
})

describe("ergonomic-facade.CLAIMED_WORK_API.4 — handler failure produces Exit.Failure observed by recordOutcome", () => {
  it("typed handler failure flows as Exit.Failure into the recorder and the run terminalizes as failed", async () => {
    const runId = "run-launch-fail"
    const completionId = "cmp-launch-fail"
    const url = await seedReadyRun("facade-launch-fail", runId, completionId, "input")

    const exitsRef = await Effect.runPromise(
      Ref.make<Array<Exit.Exit<unknown, unknown>>>([]),
    )
    const recordingRecorder = (item: ReadyWorkItem, exit: Exit.Exit<unknown, unknown>) =>
      Effect.zipRight(
        Ref.update(exitsRef, (a) => [...a, exit]),
        kernelRunRecorder(url)(item, exit),
      )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const projection = yield* Projection
          yield* Work.runScoped(
            projection.stream(readyWorkQuery).pipe(
              Stream.flatMap((items) => Stream.fromIterable(items)),
              Work.claimedBy<ReadyWorkItem>("operator-fail", (i) => i.runId),
              Work.perform(() => Effect.fail({ code: "LAUNCH_BOOM" })),
              Work.recordOutcome(recordingRecorder),
              Stream.take(1),
            ),
          )
        }),
      ).pipe(
        Effect.provide(ProjectionLive({ streamUrl: url })),
        Effect.provide(WorkClaimLive({ streamUrl: url })),
      ),
    )

    const exits = await Effect.runPromise(Ref.get(exitsRef))
    expect(exits.length).toBe(1)
    expect(Exit.isFailure(exits[0]!)).toBe(true)
    if (Exit.isFailure(exits[0]!)) {
      expect(Cause.failureOption(exits[0]!.cause)._tag).toBe("Some")
    }

    const finalSnap = await rebuildProjection({ url })
    expect(finalSnap.runs.get(runId)?.state).toBe("failed")
  })
})

// ergonomic-facade.CLAIMED_WORK_API.3 — handler invoked only after claim
// won. The spying WorkClaim layer below shares one ordering log with the
// handler so the test can assert that for the same workId the
// "claim-completed" entry strictly precedes the "handler-started" entry.
describe("ergonomic-facade.CLAIMED_WORK_API.3 — claim-before-perform ordering", () => {
  it("for each pipeline run, the claim attempt completes before the handler is invoked", async () => {
    const runId = "run-claim-before"
    const completionId = "cmp-claim-before"
    const url = await seedReadyRun("facade-claim-before", runId, completionId, "go")

    type Entry = { readonly kind: "claim-completed" | "handler-started"; readonly workId: string }
    const orderingLog = await Effect.runPromise(Ref.make<Array<Entry>>([]))

    const SpyingWorkClaimLive = (cfg: { readonly streamUrl: string }) =>
      Layer.effect(
        WorkClaim,
        Effect.map(WorkClaim, (live) => ({
          attempt: (
            input: { readonly workId: string; readonly ownerId: string },
          ): Effect.Effect<ClaimAttemptOutcome, WorkClaimError> =>
            live.attempt(input).pipe(
              Effect.tap(() =>
                Ref.update(orderingLog, (a) => [
                  ...a,
                  { kind: "claim-completed" as const, workId: input.workId },
                ]),
              ),
            ),
        })).pipe(Effect.provide(WorkClaimLive(cfg))),
      )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const projection = yield* Projection
          yield* Work.runScoped(
            projection.stream(readyWorkQuery).pipe(
              Stream.flatMap((items) => Stream.fromIterable(items)),
              Work.claimedBy<ReadyWorkItem>("operator-cb", (i) => i.runId),
              Work.perform((item) =>
                Effect.zipRight(
                  Ref.update(orderingLog, (a) => [
                    ...a,
                    { kind: "handler-started" as const, workId: item.runId },
                  ]),
                  Effect.succeed({ ok: true }),
                ),
              ),
              Work.recordOutcome(kernelRunRecorder(url)),
              Stream.take(1),
            ),
          )
        }),
      ).pipe(
        Effect.provide(SpyingWorkClaimLive({ streamUrl: url })),
        Effect.provide(ProjectionLive({ streamUrl: url })),
      ),
    )

    const log = await Effect.runPromise(Ref.get(orderingLog))
    const claimIdx = log.findIndex((e) => e.kind === "claim-completed" && e.workId === runId)
    const handlerIdx = log.findIndex((e) => e.kind === "handler-started" && e.workId === runId)
    expect(claimIdx).toBeGreaterThanOrEqual(0)
    expect(handlerIdx).toBeGreaterThanOrEqual(0)
    expect(claimIdx).toBeLessThan(handlerIdx)

    const finalRun = (await rebuildProjection({ url })).runs.get(runId)
    expect(finalRun?.state).toBe("completed")
  })
})

// ergonomic-facade.CLAIMED_WORK_API.7
// effect-native-api.OPERATOR_PROGRAMS.10 — handler dependency requirements
// are preserved in the returned Effect type.
class FakeAgentRuntime extends Context.Tag("test/FakeAgentRuntime")<
  FakeAgentRuntime,
  { readonly launch: (id: string) => Effect.Effect<{ readonly agentId: string }> }
>() {}

describe("ergonomic-facade.CLAIMED_WORK_API.7 — Work.perform preserves handler R requirements", () => {
  it("a handler that yields a Context service requires that service in the pipeline", async () => {
    const runId = "run-deps"
    const completionId = "cmp-deps"
    const url = await seedReadyRun("facade-deps", runId, completionId, "irrelevant")

    const program = Effect.scoped(
      Effect.gen(function* () {
        const projection = yield* Projection
        yield* Work.runScoped(
          projection.stream(readyWorkQuery).pipe(
            Stream.flatMap((items) => Stream.fromIterable(items)),
            Work.claimedBy<ReadyWorkItem>("operator-deps", (i) => i.runId),
            Work.perform((item) =>
              Effect.gen(function* () {
                const agent = yield* FakeAgentRuntime
                return yield* agent.launch(item.runId)
              }),
            ),
            Work.recordOutcome(kernelRunRecorder(url)),
            Stream.take(1),
          ),
        )
      }),
    )

    await Effect.runPromise(
      program.pipe(
        Effect.provide(
          Layer.succeed(FakeAgentRuntime, {
            launch: (id) => Effect.succeed({ agentId: `agent-for-${id}` }),
          }),
        ),
        Effect.provide(ProjectionLive({ streamUrl: url })),
        Effect.provide(WorkClaimLive({ streamUrl: url })),
      ),
    )

    const finalRun = (await rebuildProjection({ url })).runs.get(runId)
    expect(finalRun?.state).toBe("completed")
    expect(finalRun?.result).toEqual({ agentId: `agent-for-${runId}` })
  })
})
