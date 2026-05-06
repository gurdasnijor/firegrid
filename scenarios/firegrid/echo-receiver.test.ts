import { DurableStream } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import { Effect, Fiber, Schedule } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { makeEchoScenarioRows } from "./echo.ts"
import { inspectScenarioStream } from "./inspect.ts"
import { runEchoReceiver } from "./echo-receiver.ts"

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

describe("F3A Echo receiver scenario", () => {
  it("firegrid-runtime-process.SCENARIOS.7, firegrid-runtime-process.RUNTIME_RUN_API.1, firegrid-runtime-process.READY_WORK_OPERATOR.7, firegrid-operation-messaging.RUNTIME_HANDLERS.1, firegrid-operation-messaging.RUNTIME_HANDLERS.4 — app-owned run terminalizes the F1A Echo row and inspect observes completion", async () => {
    const streamUrl = await createStream("f3a-echo-receiver")

    const completed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(runEchoReceiver(streamUrl))
          yield* appendRows(streamUrl, makeEchoScenarioRows())

          const inspection = yield* Effect.promise(() =>
            inspectScenarioStream(streamUrl)
          ).pipe(
            Effect.filterOrFail(
              (report) =>
                report.runs.some((run) =>
                  run.runId === "run-echo-cli-1"
                  && run.state === "completed"
                  && (run.result as { readonly length?: unknown } | undefined)
                    ?.length === 14
                ),
              () => new Error("Echo run not completed yet"),
            ),
            Effect.retry({
              times: 50,
              schedule: Schedule.spaced("50 millis"),
            }),
          )

          yield* Fiber.interrupt(fiber)
          return inspection.runs.find((run) =>
            run.runId === "run-echo-cli-1"
          )
        }),
      ),
    )

    expect(completed).toMatchObject({
      runId: "run-echo-cli-1",
      state: "completed",
      operation: "Echo",
      result: {
        message: "hello firegrid",
        length: 14,
      },
    })
  })
})
