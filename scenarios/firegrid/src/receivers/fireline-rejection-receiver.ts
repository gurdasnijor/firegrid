import { Firegrid, run } from "@firegrid/runtime"
import {
  ProjectionMatchTrigger,
  RunWait,
  triggerMatchersLayer,
  type TriggerMatcher,
} from "@firegrid/substrate"
import { Effect, Fiber, Schedule } from "effect"
import { defineReceiverScenario } from "../definition.ts"
import {
  inspectSnapshot,
  type ScenarioInspection,
} from "../inspect.ts"
import {
  appendRows,
  inspect,
  withScenarioTestServer,
} from "../runner.ts"
import {
  FirelineDecisionEvents,
  FirelineRejectionOperation,
  FirelineRejectionResult,
  makeFirelineRejectionScenarioRows,
} from "../emitters/fireline-rejection.ts"

class ScenarioNotReady extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(reason)
    this.name = "ScenarioNotReady"
    this.reason = reason
  }
}

const firelineRejectionMatcher: TriggerMatcher = () =>
  Effect.succeed({ kind: "match", value: { status: "rejected" } })

const rejectedRequestFromSnapshot = (
  inspection: ScenarioInspection,
  requestId: string,
) =>
  inspection.eventStreams.find((item) => {
    const event = item.event as {
      readonly requestId?: unknown
      readonly status?: unknown
    }
    return item.stream === FirelineDecisionEvents.name &&
      event.requestId === requestId &&
      event.status === "rejected"
  })

const firelineRejectionEvaluator = (
  inspection: ScenarioInspection,
  trigger: ProjectionMatchTrigger,
) => {
  if (trigger.matcherId !== "scenario.fireline.rejected") {
    return { kind: "no-match" as const }
  }
  const prefix = `${FirelineDecisionEvents.name}:decision:`
  if (!trigger.projectionKey.startsWith(prefix)) {
    return { kind: "no-match" as const }
  }
  const requestId = trigger.projectionKey.slice(prefix.length)
  const row = rejectedRequestFromSnapshot(inspection, requestId)
  if (row === undefined) return { kind: "no-match" as const }
  const event = row.event as {
    readonly reason?: unknown
    readonly reviewer?: unknown
  }
  return {
    kind: "match" as const,
    value: {
      requestId,
      status: "rejected" as const,
      reason: event.reason,
      reviewer: event.reviewer,
    },
  }
}

const firelineRejectionReceiverRuntime = (streamUrl: string) =>
  // firegrid-runtime-process.RUNTIME_COMPOSITION.1
  // firegrid-runtime-process.RUNTIME_COMPOSITION.2
  // firegrid-runtime-process.RUNTIME_COMPOSITION.6
  Firegrid.composeRuntime({
    subscribers: [
      // firegrid-runtime-process.SCENARIOS.14
      // durable-subscribers.PROJECTION_MATCH_SUBSCRIBER.1
      // durable-subscribers.PROJECTION_MATCH_SUBSCRIBER.4
      Firegrid.subscribers.projectionMatch({
        evaluate: (snapshot, trigger) =>
          Effect.succeed(
            firelineRejectionEvaluator(
              inspectSnapshot(streamUrl, snapshot),
              trigger,
            ),
          ),
      }),
    ],
    handlers: [
      // firegrid-runtime-process.SCENARIOS.14
      // firegrid-runtime-process.SCENARIOS.16
      // run-wait-primitives.RUN_WAIT_API.1
      // run-wait-primitives.RUN_WAIT_API.2
      // run-wait-primitives.BOUNDARY.4
      // run-wait-primitives.BOUNDARY.5
      // run-wait-primitives.VOCABULARY.1
      Firegrid.handler(FirelineRejectionOperation, (input) =>
        Effect.gen(function* () {
          const wait = yield* RunWait
          const rejected = yield* wait.for(input.trigger, {
            resultSchema: FirelineRejectionResult,
          })
          return yield* Effect.fail({
            _tag: "FirelineRequestRejected" as const,
            requestId: rejected.requestId,
            reason: rejected.reason,
            reviewer: rejected.reviewer,
          })
        }),
      ),
    ],
    provide: [
      // run-wait-primitives.RUN_WAIT_API.6
      // run-wait-primitives.BOUNDARY.4
      // run-wait-primitives.BOUNDARY.5
      RunWait.layer({ streamUrl }),
      triggerMatchersLayer({
        "scenario.fireline.rejected": firelineRejectionMatcher,
      }),
    ],
  })

const runFirelineRejectionReceiver = (streamUrl: string) =>
  // firegrid-runtime-process.RUNTIME_RUN_API.1
  // firegrid-runtime-process.RUNTIME_RUN_API.2
  // firegrid-runtime-process.RUNTIME_RUN_API.3
  // firegrid-runtime-process.RUNTIME_RUN_API.5
  // firegrid-runtime-process.RUNTIME_RUN_API.6
  // firegrid-runtime-process.RUNTIME_RUN_API.8
  // firegrid-runtime-process.RUNTIME_RUN_API.9
  run({
    connection: { streamUrl },
    runtime: firelineRejectionReceiverRuntime(streamUrl),
  })

const failedFirelineRejectionScenario = (
  inspection: ScenarioInspection,
  runId: string,
  requestId: string,
) => {
  const runValue = inspection.runs.find((item) => item.runId === runId)
  const completion = inspection.completions.find((item) =>
    item.completionId === runValue?.blockedOnCompletionId &&
    item.kind === "projection_match" &&
    item.state === "resolved"
  )
  const error = runValue?.error as
    | {
      readonly _tag?: string
      readonly requestId?: string
      readonly reason?: string
      readonly reviewer?: string
    }
    | undefined
  return runValue?.state === "failed" &&
    error?._tag === "FirelineRequestRejected" &&
    error.requestId === requestId &&
    completion !== undefined &&
    rejectedRequestFromSnapshot(inspection, requestId) !== undefined &&
    inspection.counts.readyWork === 0
}

const waitForFailedScenario = (input: {
  readonly streamUrl: string
  readonly runId: string
  readonly requestId: string
}) =>
  inspect(input.streamUrl).pipe(
    Effect.flatMap((inspection) =>
      failedFirelineRejectionScenario(
        inspection,
        input.runId,
        input.requestId,
      )
        ? Effect.succeed(inspection)
        : Effect.fail(new ScenarioNotReady("not terminal yet"))
    ),
    Effect.retry({
      times: 80,
      schedule: Schedule.spaced("100 millis"),
    }),
  )

export const selfTestFirelineRejectionReceiver = () =>
  withScenarioTestServer(({ streamUrl }) =>
    Effect.gen(function* () {
      const runId = `run-fireline-rejection-${crypto.randomUUID()}`
      const eventId = `event-fireline-rejected-${crypto.randomUUID()}`
      const requestId = `request-fireline-rejection-${crypto.randomUUID()}`

      const fiber = yield* Effect.forkScoped(
        runFirelineRejectionReceiver(streamUrl),
      )
      yield* Effect.sleep("200 millis")

      yield* appendRows(
        streamUrl,
        makeFirelineRejectionScenarioRows({ runId, eventId, requestId }),
      )

      const failed = yield* waitForFailedScenario({
        streamUrl,
        runId,
        requestId,
      })
      yield* Fiber.interrupt(fiber)

      return {
        streamUrl,
        failed,
      } as const
    }),
  )

export const firelineRejectionReceiverScenario = defineReceiverScenario({
  kind: "receiver",
  name: "fireline-rejection-receiver",
  run: runFirelineRejectionReceiver,
  selfTest: selfTestFirelineRejectionReceiver,
})
