import { Firegrid, run } from "@firegrid/runtime"
import { RunWait } from "@firegrid/substrate"
import { Data, Effect, Fiber, Layer, Schedule } from "effect"
import { defineReceiverScenario } from "../definition.ts"
import type { ScenarioInspection } from "../inspect.ts"
import {
  appendRows,
  inspect,
  withScenarioTestServer,
} from "../runner.ts"
import {
  DEFAULT_SLEEP_DURATION_MS,
  DEFAULT_SLEEP_LABEL,
  SleepOperation,
  makeSleepScenarioRows,
} from "../emitters/sleep.ts"

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
    // run-wait-primitives.RUN_WAIT_API.3
    // run-wait-primitives.RUN_WAIT_API.6
    Firegrid.handler(SleepOperation, (input) =>
      Effect.gen(function* () {
        const wait = yield* RunWait
        yield* wait.sleep(input.durationMs)
        return {
          durationMs: input.durationMs,
          label: input.label,
          slept: true,
        }
      }),
    ),
  ).pipe(
    Layer.provide(
      // run-wait-primitives.BOUNDARY.4
      // run-wait-primitives.BOUNDARY.5
      RunWait.layer({ streamUrl }),
    ),
  )

const runSleepReceiver = (streamUrl: string) =>
  // firegrid-runtime-process.SCENARIOS.16
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
  withScenarioTestServer(({ streamUrl }) =>
    Effect.gen(function* () {
      const runId = `run-sleep-receiver-${crypto.randomUUID()}`
      const durationMs = 2_000
      const label = `timer-${crypto.randomUUID()}`

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
    }),
  )

export const sleepReceiverScenario = defineReceiverScenario({
  kind: "receiver",
  name: "sleep-receiver",
  run: runSleepReceiver,
  selfTest: selfTestSleepReceiver,
})
