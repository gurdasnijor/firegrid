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
  FirelineApprovalEvents,
  FirelineShapedOperation,
  makeFirelineShapedScenarioRows,
} from "../emitters/fireline-shaped.ts"

class ScenarioNotReady extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(reason)
    this.name = "ScenarioNotReady"
    this.reason = reason
  }
}

const firelineApprovalMatcher: TriggerMatcher = () =>
  Effect.succeed({ kind: "match", value: { approved: true } })

const approvedRequestFromSnapshot = (
  inspection: ScenarioInspection,
  requestId: string,
) =>
  inspection.eventStreams.find((item) => {
    const event = item.event as {
      readonly requestId?: unknown
      readonly status?: unknown
    }
    return item.stream === FirelineApprovalEvents.name &&
      event.requestId === requestId &&
      event.status === "approved"
  })

const firelineApprovalEvaluator = (
  inspection: ScenarioInspection,
  trigger: ProjectionMatchTrigger,
) => {
  if (trigger.matcherId !== "scenario.fireline.approved") {
    return { kind: "no-match" as const }
  }
  const prefix = `${FirelineApprovalEvents.name}:approval:`
  if (!trigger.projectionKey.startsWith(prefix)) {
    return { kind: "no-match" as const }
  }
  const requestId = trigger.projectionKey.slice(prefix.length)
  const event = approvedRequestFromSnapshot(inspection, requestId)
  if (event === undefined) return { kind: "no-match" as const }
  return {
    kind: "match" as const,
    value: {
      requestId,
      approved: true,
    },
  }
}

const firelineShapedReceiverRuntime = (streamUrl: string) =>
  // firegrid-runtime-process.RUNTIME_COMPOSITION.1
  // firegrid-runtime-process.RUNTIME_COMPOSITION.2
  // firegrid-runtime-process.RUNTIME_COMPOSITION.6
  Firegrid.composeRuntime({
    subscribers: [
      // firegrid-runtime-process.SCENARIOS.13
      // durable-subscribers.PROJECTION_MATCH_SUBSCRIBER.1
      // durable-subscribers.PROJECTION_MATCH_SUBSCRIBER.4
      Firegrid.subscribers.projectionMatch({
        evaluate: (snapshot, trigger) =>
          Effect.succeed(
            firelineApprovalEvaluator(
              inspectSnapshot(streamUrl, snapshot),
              trigger,
            ),
          ),
      }),
    ],
    handlers: [
      // firegrid-runtime-process.SCENARIOS.13
      // firegrid-runtime-process.SCENARIOS.16
      // run-wait-primitives.RUN_WAIT_API.1
      // run-wait-primitives.RUN_WAIT_API.2
      // run-wait-primitives.BOUNDARY.4
      // run-wait-primitives.BOUNDARY.5
      // run-wait-primitives.VOCABULARY.1
      Firegrid.handler(FirelineShapedOperation, (input) =>
        Effect.gen(function* () {
          const wait = yield* RunWait
          yield* wait.for(input.trigger)
          return {
            requestId: input.requestId,
            approved: true,
          }
        }),
      ),
    ],
    provide: [
      // run-wait-primitives.RUN_WAIT_API.6
      // run-wait-primitives.BOUNDARY.4
      // run-wait-primitives.BOUNDARY.5
      RunWait.layer({ streamUrl }),
      triggerMatchersLayer({
        "scenario.fireline.approved": firelineApprovalMatcher,
      }),
    ],
  })

const runFirelineShapedReceiver = (streamUrl: string) =>
  // firegrid-runtime-process.RUNTIME_RUN_API.1
  // firegrid-runtime-process.RUNTIME_RUN_API.2
  // firegrid-runtime-process.RUNTIME_RUN_API.3
  // firegrid-runtime-process.RUNTIME_RUN_API.5
  // firegrid-runtime-process.RUNTIME_RUN_API.6
  // firegrid-runtime-process.RUNTIME_RUN_API.8
  // firegrid-runtime-process.RUNTIME_RUN_API.9
  run({
    connection: { streamUrl },
    runtime: firelineShapedReceiverRuntime(streamUrl),
  })

const completedFirelineShapedScenario = (
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
  const result = runValue?.result as
    | { readonly requestId?: string; readonly approved?: boolean }
    | undefined
  return runValue?.state === "completed" &&
    result?.requestId === requestId &&
    result.approved === true &&
    completion !== undefined &&
    approvedRequestFromSnapshot(inspection, requestId) !== undefined &&
    inspection.counts.readyWork === 0
}

const waitForCompletedScenario = (input: {
  readonly streamUrl: string
  readonly runId: string
  readonly requestId: string
}) =>
  inspect(input.streamUrl).pipe(
    Effect.flatMap((inspection) =>
      completedFirelineShapedScenario(
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

export const selfTestFirelineShapedReceiver = () =>
  withScenarioTestServer(({ streamUrl }) =>
    Effect.gen(function* () {
      const runId = `run-fireline-shaped-${crypto.randomUUID()}`
      const eventId = `event-fireline-approved-${crypto.randomUUID()}`
      const requestId = `request-fireline-shaped-${crypto.randomUUID()}`

      const fiber = yield* Effect.forkScoped(
        runFirelineShapedReceiver(streamUrl),
      )
      yield* Effect.sleep("200 millis")

      yield* appendRows(
        streamUrl,
        makeFirelineShapedScenarioRows({ runId, eventId, requestId }),
      )

      const completed = yield* waitForCompletedScenario({
        streamUrl,
        runId,
        requestId,
      })
      yield* Fiber.interrupt(fiber)

      return {
        streamUrl,
        completed,
      } as const
    }),
  )

export const firelineShapedReceiverScenario = defineReceiverScenario({
  kind: "receiver",
  name: "fireline-shaped-receiver",
  run: runFirelineShapedReceiver,
  selfTest: selfTestFirelineShapedReceiver,
})
