#!/usr/bin/env tsx
import { DurableStream } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import { Firegrid, run } from "@firegrid/runtime"
import {
  Choreography,
  ChoreographyLive,
} from "@firegrid/substrate"
import { DurableWaitsLive } from "@firegrid/substrate/kernel"
import { Data, Effect, Fiber, Layer, Schedule } from "effect"
import { parseArgs } from "node:util"
import { fileURLToPath } from "node:url"
import {
  inspectScenarioStream,
  type ScenarioInspection,
} from "./inspect.ts"
import {
  DEFAULT_SLEEP_DURATION_MS,
  DEFAULT_SLEEP_LABEL,
  SleepOperation,
  makeSleepScenarioRows,
} from "./sleep.ts"

class ScenarioInspectionFailed extends Data.TaggedError(
  "ScenarioInspectionFailed",
)<{
  readonly cause: unknown
}> {}

class ScenarioSeedFailed extends Data.TaggedError("ScenarioSeedFailed")<{
  readonly cause: unknown
}> {}

class ScenarioNotReady extends Data.TaggedError("ScenarioNotReady")<{
  readonly reason: string
}> {}

const sleepReceiverRuntime = (streamUrl: string) =>
  Layer.mergeAll(
    // firegrid-runtime-process.SCENARIOS.11
    // durable-subscribers.TIMER_SUBSCRIBER.1
    // durable-subscribers.TIMER_SUBSCRIBER.2
    // durable-subscribers.TIMER_SUBSCRIBER.3
    // durable-subscribers.TIMER_SUBSCRIBER.4
    Firegrid.subscribers.timer,
    // firegrid-runtime-process.READY_WORK_OPERATOR.1
    // firegrid-runtime-process.READY_WORK_OPERATOR.5
    // firegrid-runtime-process.READY_WORK_OPERATOR.7
    Firegrid.handler(SleepOperation, (input) =>
      Effect.gen(function* () {
        const choreo = yield* Choreography
        yield* choreo.sleep(input.durationMs)
        return {
          durationMs: input.durationMs,
          label: input.label,
          slept: true,
        }
      }),
    ),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ChoreographyLive({ streamUrl }),
        DurableWaitsLive({ streamUrl }),
      ),
    ),
  )

export const runSleepReceiver = (streamUrl: string) =>
  // firegrid-runtime-process.RUNTIME_RUN_API.1
  // firegrid-runtime-process.RUNTIME_RUN_API.2
  // firegrid-runtime-process.RUNTIME_RUN_API.3
  // firegrid-runtime-process.RUNTIME_RUN_API.5
  // firegrid-runtime-process.RUNTIME_RUN_API.6
  // firegrid-runtime-process.RUNTIME_RUN_API.8
  // firegrid-runtime-process.RUNTIME_RUN_API.9
  run({
    connection: { streamUrl },
    runtime: sleepReceiverRuntime(streamUrl),
  })

const appendRows = (
  streamUrl: string,
  rows: ReadonlyArray<unknown>,
): Effect.Effect<void, ScenarioSeedFailed> =>
  Effect.tryPromise({
    try: async () => {
      const stream = new DurableStream({
        url: streamUrl,
        contentType: "application/json",
      })
      for (const row of rows) {
        await stream.append(JSON.stringify(row))
      }
    },
    catch: (cause) => new ScenarioSeedFailed({ cause }),
  })

const createScenarioStream = (
  streamUrl: string,
): Effect.Effect<void, ScenarioSeedFailed> =>
  Effect.tryPromise({
    try: async () => {
      await DurableStream.create({
        url: streamUrl,
        contentType: "application/json",
      })
    },
    catch: (cause) => new ScenarioSeedFailed({ cause }),
  })

const inspect = (
  streamUrl: string,
): Effect.Effect<ScenarioInspection, ScenarioInspectionFailed> =>
  Effect.tryPromise({
    try: () => inspectScenarioStream(streamUrl),
    catch: (cause) => new ScenarioInspectionFailed({ cause }),
  })

const pendingBeforeDue = (
  inspection: ScenarioInspection,
  input: {
    readonly runId: string
  },
) => {
  const runValue = inspection.runs.find((item) => item.runId === input.runId)
  const completion = inspection.completions.find((item) =>
    item.completionId === runValue?.blockedOnCompletionId &&
    item.kind === "timer"
  )
  return runValue?.state === "blocked" &&
    completion?.state === "pending" &&
    typeof completion.dueAtMs === "number"
}

const completedSleepScenario = (
  inspection: ScenarioInspection,
  input: {
    readonly runId: string
    readonly durationMs: number
    readonly label: string
  },
) => {
  const runValue = inspection.runs.find((item) => item.runId === input.runId)
  const completion = inspection.completions.find((item) =>
    item.completionId === runValue?.blockedOnCompletionId &&
    item.kind === "timer" &&
    item.state === "resolved"
  )
  const result = runValue?.result as
    | {
      readonly durationMs?: number
      readonly label?: string
      readonly slept?: boolean
    }
    | undefined
  const completionResult = completion?.result as
    | { readonly dueAtMs?: number; readonly observedFireMs?: number }
    | undefined
  return runValue?.state === "completed" &&
    result?.durationMs === input.durationMs &&
    result.label === input.label &&
    result.slept === true &&
    completion !== undefined &&
    typeof completionResult?.dueAtMs === "number" &&
    typeof completionResult.observedFireMs === "number"
}

const waitForBlockedScenario = (input: {
  readonly streamUrl: string
  readonly runId: string
}) =>
  inspect(input.streamUrl).pipe(
    Effect.flatMap((inspection) =>
      pendingBeforeDue(inspection, input)
        ? Effect.succeed(inspection)
        : Effect.fail(new ScenarioNotReady({ reason: "not blocked yet" }))
    ),
    Effect.retry({
      times: 40,
      schedule: Schedule.spaced("50 millis"),
    }),
  )

const waitForCompletedScenario = (input: {
  readonly streamUrl: string
  readonly runId: string
  readonly durationMs: number
  readonly label: string
}) =>
  inspect(input.streamUrl).pipe(
    Effect.flatMap((inspection) =>
      completedSleepScenario(inspection, input)
        ? Effect.succeed(inspection)
        : Effect.fail(new ScenarioNotReady({ reason: "not terminal yet" }))
    ),
    Effect.retry({
      times: 80,
      schedule: Schedule.spaced("100 millis"),
    }),
  )

export const selfTestSleepReceiver = () =>
  Effect.gen(function* () {
    const server = yield* Effect.tryPromise({
      try: async () => {
        const instance = new DurableStreamTestServer({ port: 0 })
        await instance.start()
        return instance
      },
      catch: (cause) => new ScenarioSeedFailed({ cause }),
    })
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => server.stop()).pipe(Effect.orDie),
    )

    const runId = `run-sleep-receiver-${crypto.randomUUID()}`
    const durationMs = 2_000
    const label = `timer-${crypto.randomUUID()}`
    const streamUrl = `${server.url}/scenarios/sleep-receiver-${crypto.randomUUID()}`

    yield* createScenarioStream(streamUrl)
    const fiber = yield* Effect.forkScoped(runSleepReceiver(streamUrl))
    yield* appendRows(
      streamUrl,
      makeSleepScenarioRows({ runId, durationMs, label }),
    )

    const beforeDue = yield* waitForBlockedScenario({
      streamUrl,
      runId,
    })
    const completed = yield* waitForCompletedScenario({
      streamUrl,
      runId,
      durationMs,
      label,
    })
    yield* Fiber.interrupt(fiber)

    return {
      streamUrl,
      beforeDue,
      completed,
    } as const
  }).pipe(Effect.scoped)

const main = async () => {
  const { values } = parseArgs({
    options: {
      "self-test": { type: "boolean", default: false },
      "stream-url": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  })

  if (values["self-test"]) {
    const result = await Effect.runPromise(selfTestSleepReceiver())
    process.stdout.write(`${JSON.stringify(result.completed, null, 2)}\n`)
    process.exit(0)
    return
  }

  const streamUrl = values["stream-url"] ?? process.env.DURABLE_STREAMS_URL
  if (streamUrl === undefined || streamUrl.length === 0) {
    process.stderr.write(
      "Usage: pnpm --filter @firegrid/scenarios run sleep-receiver -- --stream-url <durable-stream-url>\n",
    )
    process.exitCode = 1
    return
  }

  await Effect.runPromise(runSleepReceiver(streamUrl))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}

export {
  DEFAULT_SLEEP_DURATION_MS,
  DEFAULT_SLEEP_LABEL,
}
