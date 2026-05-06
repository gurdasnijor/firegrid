import { DurableStream } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import { Effect, Fiber, Layer, Ref, Schedule } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Firegrid, run } from "@firegrid/runtime"
import {
  ChargeCardOperation,
  makeClaimBeforeSideEffectScenarioRows,
} from "./claim-before-side-effect.ts"
import { inspectScenarioStream } from "./inspect.ts"

let server: DurableStreamTestServer | undefined

beforeAll(async () => {
  server = new DurableStreamTestServer({ port: 0 })
  await server.start()
})

afterAll(async () => {
  await server?.stop()
  server = undefined
})

const freshStreamUrl = (label: string) => {
  if (server === undefined) throw new Error("test server not started")
  return `${server.url}/substrate/${label}-${crypto.randomUUID()}`
}

const createStream = async (label: string): Promise<string> => {
  const streamUrl = freshStreamUrl(label)
  await DurableStream.create({
    url: streamUrl,
    contentType: "application/json",
  })
  return streamUrl
}

const appendRows = (
  streamUrl: string,
  rows: ReadonlyArray<unknown>,
): Effect.Effect<void> =>
  Effect.promise(async () => {
    const stream = new DurableStream({
      url: streamUrl,
      contentType: "application/json",
    })
    for (const row of rows) {
      await stream.append(JSON.stringify(row))
    }
  })

interface InvocationRecord {
  readonly participantId: string
  readonly sideEffectId: string
}

const buildHandlerLayer = (
  participantId: string,
  invocations: Ref.Ref<ReadonlyArray<InvocationRecord>>,
) =>
  Firegrid.handler(ChargeCardOperation, (input) =>
    Effect.gen(function* () {
      yield* Ref.update(invocations, (xs) => [
        ...xs,
        { participantId, sideEffectId: input.sideEffectId },
      ])
      return { sideEffectId: input.sideEffectId, status: "charged" as const }
    }),
  )

describe("F3D claim-before-side-effect receiver — competing participants", () => {
  it(
    "firegrid-runtime-process.SCENARIOS.7, firegrid-runtime-process.RUNTIME_RUN_API.1, firegrid-runtime-process.READY_WORK_OPERATOR.7, claim-and-operator-authority.CLAIM_BEFORE_INVOKE.1, claim-and-operator-authority.CLAIM_AUTHORITY.1, claim-and-operator-authority.TERMINAL_AUTHORITY.1 — exactly one app-owned participant runs the side-effect and terminalizes the F1E ChargeCard run",
    async () => {
      const streamUrl = await createStream("f3d-claim-receiver")
      // Seed the F1E rows BEFORE attaching participants so both observe the
      // ready-work item on their first scan (run is already blocked, completion
      // already resolved). Substrate's first-valid-terminal-wins authority
      // arbitrates.
      const seedRows = makeClaimBeforeSideEffectScenarioRows({
        runId: "run-claim-side-effect-receiver-1",
        completionId: "completion-claim-side-effect-receiver-1",
        sideEffectId: "side-effect-receiver-1",
        target: "card-token-receiver-1",
        amountCents: 4200,
      })

      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* appendRows(streamUrl, seedRows)

            const invocations = yield* Ref.make<ReadonlyArray<InvocationRecord>>(
              [],
            )

            const fibers = yield* Effect.all(
              Array.from({ length: 2 }, (_, i) => `participant-${i + 1}`).map(
                (participantId) =>
                  Effect.fork(
                    run({
                      connection: { streamUrl },
                      runtime: buildHandlerLayer(participantId, invocations),
                    }),
                  ),
              ),
            )

            const inspection = yield* Effect.promise(() =>
              inspectScenarioStream(streamUrl),
            ).pipe(
              Effect.filterOrFail(
                (report) =>
                  report.runs.some(
                    (r) =>
                      r.runId === "run-claim-side-effect-receiver-1" &&
                      r.state === "completed",
                  ),
                () => new Error("ChargeCard run not completed yet"),
              ),
              Effect.retry({
                times: 80,
                schedule: Schedule.spaced("100 millis"),
              }),
            )

            const recorded = yield* Ref.get(invocations)
            yield* Effect.forEach(fibers, Fiber.interrupt, { discard: true })

            return { inspection, recorded }
          }),
        ),
      )

      const completed = result.inspection.runs.find(
        (r) => r.runId === "run-claim-side-effect-receiver-1",
      )
      expect(completed).toMatchObject({
        runId: "run-claim-side-effect-receiver-1",
        state: "completed",
        operation: "ChargeCard",
        result: {
          sideEffectId: "side-effect-receiver-1",
          status: "charged",
        },
      })

      // claim-and-operator-authority.CLAIM_BEFORE_INVOKE.1
      // claim-and-operator-authority.CLAIM_AUTHORITY.1
      expect(result.recorded).toHaveLength(1)
      expect(result.recorded[0]?.sideEffectId).toBe("side-effect-receiver-1")
      expect(["participant-1", "participant-2"]).toContain(
        result.recorded[0]?.participantId,
      )
      // At least one durable claim-attempt row exists (the winner's).
      // The substrate authored the terminal upsert; runtime never appended
      // completeRun directly — verified architecturally in
      // packages/runtime/src/__tests__/runtime-foundations.test.ts.
      expect(result.inspection.counts.claimAttempts).toBeGreaterThanOrEqual(1)
    },
  )
})
