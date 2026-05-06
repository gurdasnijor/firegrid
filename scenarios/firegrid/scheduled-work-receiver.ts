#!/usr/bin/env tsx
import { DurableStream } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import { Firegrid, run } from "@firegrid/runtime"
import { Data, Effect, Fiber, Layer, Schedule } from "effect"
import { parseArgs } from "node:util"
import { fileURLToPath } from "node:url"
import {
  ScheduledReminderOperation,
  makeScheduledWorkScenarioRows,
} from "./scheduled-work.ts"
import { inspectScenarioStream, type ScenarioInspection } from "./inspect.ts"
import {
  blockRunScenarioRow,
  makeOperationStartedRunRow,
} from "./scenario.ts"

const DEFAULT_RUN_ID = "run-scheduled-work-cli-1"
const DEFAULT_COMPLETION_ID = "completion-scheduled-work-cli-1"
const DEFAULT_REMINDER_ID = "reminder-cli-1"
const DEFAULT_MESSAGE = "follow up from scheduled work"

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

export const makeScheduledWorkReceiverSeedRows = (input: {
  readonly completionId?: string
  readonly workId?: string
  readonly reminderId?: string
  readonly message?: string
  readonly whenMs?: number
} = {}) => {
  const completionId = input.completionId ?? DEFAULT_COMPLETION_ID
  const workId = input.workId ?? DEFAULT_RUN_ID
  const reminderId = input.reminderId ?? DEFAULT_REMINDER_ID
  const message = input.message ?? DEFAULT_MESSAGE
  const whenMs = input.whenMs ?? Date.now() + 2_000

  // firegrid-runtime-process.SCENARIOS.8
  // firegrid-runtime-process.READY_WORK_OPERATOR.1
  // firegrid-runtime-process.READY_WORK_OPERATOR.7
  const startedRun = makeOperationStartedRunRow({
    runId: workId,
    operation: ScheduledReminderOperation,
    input: { reminderId, message },
  })
  const blockedRun = blockRunScenarioRow(startedRun, {
    blockedOnCompletionId: completionId,
  })

  return [
    blockedRun,
    ...makeScheduledWorkScenarioRows({
      completionId,
      workId,
      reminderId,
      message,
      whenMs,
    }),
  ] as const
}

export const writeScheduledWorkReceiverSeedRows = (
  input: {
    readonly completionId?: string
    readonly workId?: string
    readonly reminderId?: string
    readonly message?: string
    readonly whenMs?: number
  } = {},
  write: (chunk: string) => void = (chunk) => {
    process.stdout.write(chunk)
  },
) => {
  for (const row of makeScheduledWorkReceiverSeedRows(input)) {
    write(`${JSON.stringify(row)}\n`)
  }
}

const scheduledWorkReceiverRuntime = Layer.mergeAll(
  // durable-subscribers.SCHEDULED_WORK_SUBSCRIBER.1
  // durable-subscribers.SCHEDULED_WORK_SUBSCRIBER.2
  // durable-subscribers.SCHEDULED_WORK_SUBSCRIBER.3
  // durable-subscribers.SCHEDULED_WORK_SUBSCRIBER.4
  Firegrid.subscribers.scheduledWork,
  // firegrid-runtime-process.RUNTIME_RUN_API.6
  // firegrid-runtime-process.READY_WORK_OPERATOR.1
  // firegrid-runtime-process.READY_WORK_OPERATOR.2
  // firegrid-runtime-process.READY_WORK_OPERATOR.5
  Firegrid.handler(ScheduledReminderOperation, (input) =>
    Effect.succeed({
      reminderId: input.reminderId,
      message: input.message,
      delivered: true,
    }),
  ),
)

export const runScheduledWorkReceiver = (streamUrl: string) =>
  // firegrid-runtime-process.SCENARIOS.16
  // firegrid-runtime-process.RUNTIME_RUN_API.1
  // firegrid-runtime-process.RUNTIME_RUN_API.2
  // firegrid-runtime-process.RUNTIME_RUN_API.3
  // firegrid-runtime-process.RUNTIME_RUN_API.5
  // firegrid-runtime-process.RUNTIME_RUN_API.8
  // firegrid-runtime-process.RUNTIME_RUN_API.9
  run({
    connection: { streamUrl },
    runtime: scheduledWorkReceiverRuntime,
  })

const appendRows = (
  streamUrl: string,
  rows: ReadonlyArray<unknown>,
): Effect.Effect<void, ScenarioSeedFailed> =>
  Effect.tryPromise({
    try: async () => {
      const stream = await DurableStream.create({
        url: streamUrl,
        contentType: "application/json",
      })
      for (const row of rows) {
        await stream.append(JSON.stringify(row))
      }
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
    readonly completionId: string
  },
) => {
  const completion = inspection.completions.find((item) =>
    item.completionId === input.completionId
  )
  const runValue = inspection.runs.find((item) => item.runId === input.runId)
  return completion?.state === "pending" && runValue?.state === "blocked"
}

const completedAfterDue = (
  inspection: ScenarioInspection,
  input: {
    readonly runId: string
    readonly completionId: string
    readonly whenMs: number
  },
) => {
  const completion = inspection.completions.find((item) =>
    item.completionId === input.completionId
  )
  const runValue = inspection.runs.find((item) => item.runId === input.runId)
  const result = completion?.result as
    | {
      readonly whenMs?: number
      readonly input?: {
        readonly reminderId?: string
        readonly message?: string
      }
    }
    | undefined

  return completion?.state === "resolved" &&
    result?.whenMs === input.whenMs &&
    result.input?.reminderId === DEFAULT_REMINDER_ID &&
    result.input?.message === DEFAULT_MESSAGE &&
    runValue?.state === "completed"
}

const waitForCompletedScenario = (input: {
  readonly streamUrl: string
  readonly runId: string
  readonly completionId: string
  readonly whenMs: number
}) =>
  inspect(input.streamUrl).pipe(
    Effect.flatMap((inspection) =>
      completedAfterDue(inspection, input)
        ? Effect.succeed(inspection)
        : Effect.fail(new ScenarioNotReady({ reason: "not terminal yet" }))
    ),
    Effect.retry({
      times: 80,
      schedule: Schedule.spaced("100 millis"),
    }),
  )

export const selfTestScheduledWorkReceiver = () =>
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

    const runId = `run-scheduled-work-receiver-${crypto.randomUUID()}`
    const completionId = `completion-scheduled-work-receiver-${crypto.randomUUID()}`
    const whenMs = Date.now() + 2_000
    const streamUrl = `${server.url}/scenarios/scheduled-work-receiver-${crypto.randomUUID()}`
    const seedRows = makeScheduledWorkReceiverSeedRows({
      workId: runId,
      completionId,
      whenMs,
    })

    yield* appendRows(streamUrl, seedRows)

    const fiber = yield* Effect.forkScoped(
      runScheduledWorkReceiver(streamUrl),
    )
    yield* Effect.sleep("200 millis")

    const beforeDue = yield* inspect(streamUrl)
    if (!pendingBeforeDue(beforeDue, { runId, completionId })) {
      return yield* Effect.fail(
        new ScenarioNotReady({ reason: "completion resolved before due time" }),
      )
    }

    const completed = yield* waitForCompletedScenario({
      streamUrl,
      runId,
      completionId,
      whenMs,
    })
    yield* Fiber.interrupt(fiber)

    return {
      streamUrl,
      beforeDue,
      completed,
    } as const
  }).pipe(Effect.scoped)

const numberFromArg = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected numeric --when-ms, received ${value}`)
  }
  return parsed
}

const main = async () => {
  const { values } = parseArgs({
    options: {
      "seed-rows": { type: "boolean", default: false },
      "self-test": { type: "boolean", default: false },
      "stream-url": { type: "string" },
      "when-ms": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  })

  if (values["seed-rows"]) {
    writeScheduledWorkReceiverSeedRows({
      whenMs: numberFromArg(values["when-ms"]),
    })
    return
  }

  if (values["self-test"]) {
    const result = await Effect.runPromise(selfTestScheduledWorkReceiver())
    process.stdout.write(`${JSON.stringify(result.completed, null, 2)}\n`)
    process.exit(0)
    return
  }

  const streamUrl = values["stream-url"] ?? process.env.DURABLE_STREAMS_URL
  if (streamUrl === undefined || streamUrl.length === 0) {
    process.stderr.write(
      "Usage: pnpm --filter @firegrid/scenarios run scheduled-work-receiver -- --stream-url <durable-stream-url>\n",
    )
    process.exitCode = 1
    return
  }

  await Effect.runPromise(runScheduledWorkReceiver(streamUrl))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}
