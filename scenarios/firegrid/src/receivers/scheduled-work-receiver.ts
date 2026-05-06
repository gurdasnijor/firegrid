import { Firegrid, run } from "@firegrid/runtime"
import { Data, Effect, Fiber, Schedule } from "effect"
import { defineReceiverScenario } from "../definition.ts"
import {
  ScheduledReminderOperation,
  makeScheduledWorkScenarioRows,
} from "../emitters/scheduled-work.ts"
import type { ScenarioInspection } from "../inspect.ts"
import {
  appendRows,
  inspect,
  withScenarioTestServer,
} from "../runner.ts"
import {
  blockRunScenarioRow,
  makeOperationStartedRunRow,
} from "../scenario.ts"

const DEFAULT_RUN_ID = "run-scheduled-work-cli-1"
const DEFAULT_COMPLETION_ID = "completion-scheduled-work-cli-1"
const DEFAULT_REMINDER_ID = "reminder-cli-1"
const DEFAULT_MESSAGE = "follow up from scheduled work"

class ScenarioNotReady extends Data.TaggedError("ScenarioNotReady")<{
  readonly reason: string
}> {}

const makeScheduledWorkReceiverSeedRows = (input: {
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

const scheduledWorkReceiverRuntime =
  // firegrid-runtime-process.RUNTIME_COMPOSITION.1
  // firegrid-runtime-process.RUNTIME_COMPOSITION.2
  // firegrid-runtime-process.RUNTIME_COMPOSITION.6
  Firegrid.composeRuntime({
    subscribers: [
      // durable-subscribers.SCHEDULED_WORK_SUBSCRIBER.1
      // durable-subscribers.SCHEDULED_WORK_SUBSCRIBER.2
      // durable-subscribers.SCHEDULED_WORK_SUBSCRIBER.3
      // durable-subscribers.SCHEDULED_WORK_SUBSCRIBER.4
      Firegrid.subscribers.scheduledWork,
    ],
    handlers: [
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
    ],
    provide: [],
  })

const runScheduledWorkReceiver = (streamUrl: string) =>
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
  withScenarioTestServer(({ streamUrl }) =>
    Effect.gen(function* () {
      const runId = `run-scheduled-work-receiver-${crypto.randomUUID()}`
      const completionId = `completion-scheduled-work-receiver-${crypto.randomUUID()}`
      const whenMs = Date.now() + 2_000
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
          new ScenarioNotReady({
            reason: "completion resolved before due time",
          }),
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
    }),
  )

export const scheduledWorkReceiverScenario = defineReceiverScenario({
  kind: "receiver",
  name: "scheduled-work-receiver",
  run: runScheduledWorkReceiver,
  selfTest: selfTestScheduledWorkReceiver,
  seedRows: ({ whenMs }) => makeScheduledWorkReceiverSeedRows({ whenMs }),
})
