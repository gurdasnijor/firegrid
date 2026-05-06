import { DurableStream } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import { Effect, Fiber, Schedule } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { makeFailingOperationScenarioRows } from "./failing-operation.ts"
import { inspectScenarioStream } from "./inspect.ts"
import { runFailingOperationReceiver } from "./failing-operation-receiver.ts"

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

describe("S3 handler-failure receiver scenario", () => {
  it("firegrid-runtime-process.SCENARIOS.12, firegrid-runtime-process.RUNTIME_RUN_API.1, firegrid-operation-messaging.RUNTIME_HANDLERS.3, firegrid-operation-messaging.RUNTIME_HANDLERS.4 — app-owned receiver terminalizes typed handler failure as failed run observed through inspect", async () => {
    const streamUrl = await createStream("s3-handler-failure")

    const failed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(runFailingOperationReceiver(streamUrl))
          yield* appendRows(
            streamUrl,
            makeFailingOperationScenarioRows({
              runId: "run-failing-operation-receiver-1",
              requestId: "request-failing-operation-receiver-1",
              reason: "receiver failure path",
            }),
          )

          const inspection = yield* Effect.promise(() =>
            inspectScenarioStream(streamUrl)
          ).pipe(
            Effect.filterOrFail(
              (report) =>
                report.runs.some((run) =>
                  run.runId === "run-failing-operation-receiver-1"
                  && run.state === "failed"
                  && (
                    run.error as
                      | {
                        readonly _tag?: unknown
                        readonly requestId?: unknown
                        readonly reason?: unknown
                      }
                      | undefined
                  )?._tag === "ScenarioFailure"
                ),
              () => new Error("FailingOperation run not failed yet"),
            ),
            Effect.retry({
              times: 50,
              schedule: Schedule.spaced("50 millis"),
            }),
          )

          yield* Fiber.interrupt(fiber)
          return inspection.runs.find((run) =>
            run.runId === "run-failing-operation-receiver-1"
          )
        }),
      ),
    )

    expect(failed).toMatchObject({
      runId: "run-failing-operation-receiver-1",
      state: "failed",
      operation: "FailingOperation",
      error: {
        _tag: "ScenarioFailure",
        requestId: "request-failing-operation-receiver-1",
        reason: "receiver failure path",
      },
    })
  })
})
