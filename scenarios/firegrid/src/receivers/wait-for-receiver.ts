import { Firegrid, run } from "@firegrid/runtime"
import {
  RunWait,
  triggerMatchersLayer,
  type ProjectionMatchTrigger,
  type TriggerMatcher,
} from "@firegrid/substrate"
import { Data, Effect, Fiber, Layer, Schedule } from "effect"
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
  PermissionEvents,
  WaitForPermissionOperation,
  makeWaitForScenarioRows,
} from "../emitters/wait-for.ts"

class ScenarioNotReady extends Data.TaggedError("ScenarioNotReady")<{
  readonly reason: string
}> {}

const permissionMatcher: TriggerMatcher = () =>
  Effect.succeed({ kind: "match", value: { status: "approved" } })

const approvedPermissionFromSnapshot = (
  inspection: ScenarioInspection,
  permissionId: string,
) =>
  inspection.eventStreams.find((item) => {
    const event = item.event as {
      readonly actor?: unknown
      readonly permissionId?: unknown
      readonly status?: unknown
    }
    return item.stream === PermissionEvents.name &&
      event.permissionId === permissionId &&
      event.status === "approved"
  })

const permissionApprovedEvaluator = (
  inspection: ScenarioInspection,
  trigger: ProjectionMatchTrigger,
) => {
  if (trigger.matcherId !== "scenario.permission.approved") {
    return { kind: "no-match" as const }
  }
  const prefix = `${PermissionEvents.name}:permission:`
  if (!trigger.projectionKey.startsWith(prefix)) {
    return { kind: "no-match" as const }
  }
  const permissionId = trigger.projectionKey.slice(prefix.length)
  const event = approvedPermissionFromSnapshot(inspection, permissionId)
  if (event === undefined) return { kind: "no-match" as const }
  const permissionEvent = event.event as {
    readonly actor?: unknown
    readonly status?: unknown
  }
  return {
    kind: "match" as const,
    value: {
      permissionId,
      status: permissionEvent.status,
      actor: permissionEvent.actor,
    },
  }
}

const waitForReceiverRuntime = (streamUrl: string) =>
  Layer.mergeAll(
    // firegrid-runtime-process.SCENARIOS.9
    // durable-subscribers.PROJECTION_MATCH_SUBSCRIBER.1
    // durable-subscribers.PROJECTION_MATCH_SUBSCRIBER.2
    // durable-subscribers.PROJECTION_MATCH_SUBSCRIBER.3
    // durable-subscribers.PROJECTION_MATCH_SUBSCRIBER.4
    // durable-subscribers.PROJECTION_MATCH_SUBSCRIBER.7
    Firegrid.subscribers.projectionMatch({
      evaluate: (snapshot, trigger) =>
        Effect.succeed(
          permissionApprovedEvaluator(
            inspectSnapshot(streamUrl, snapshot),
            trigger,
          ),
        ),
    }),
    // firegrid-runtime-process.READY_WORK_OPERATOR.1
    // firegrid-runtime-process.READY_WORK_OPERATOR.5
    // firegrid-runtime-process.READY_WORK_OPERATOR.7
    // run-wait-primitives.RUN_WAIT_API.2
    // run-wait-primitives.RUN_WAIT_API.6
    Firegrid.handler(WaitForPermissionOperation, (input) =>
      Effect.gen(function* () {
        const wait = yield* RunWait
        yield* wait.for(input.trigger)
        return {
          permissionId: input.permissionId,
          status: "approved" as const,
        }
      }),
    ),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        // run-wait-primitives.BOUNDARY.4
        // run-wait-primitives.BOUNDARY.5
        RunWait.layer({ streamUrl }),
        triggerMatchersLayer({
          "scenario.permission.approved": permissionMatcher,
        }),
      ),
    ),
  )

const runWaitForReceiver = (streamUrl: string) =>
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
    runtime: waitForReceiverRuntime(streamUrl),
  })

const completedWaitForScenario = (
  inspection: ScenarioInspection,
  runId: string,
  permissionId: string,
) => {
  const runValue = inspection.runs.find((item) => item.runId === runId)
  const completion = inspection.completions.find((item) =>
    item.completionId === runValue?.blockedOnCompletionId &&
    item.kind === "projection_match" &&
    item.state === "resolved"
  )
  const result = runValue?.result as
    | { readonly permissionId?: string; readonly status?: string }
    | undefined
  return runValue?.state === "completed" &&
    result?.permissionId === permissionId &&
    result.status === "approved" &&
    completion !== undefined &&
    approvedPermissionFromSnapshot(inspection, permissionId) !== undefined
}

const waitForCompletedScenario = (input: {
  readonly streamUrl: string
  readonly runId: string
  readonly permissionId: string
}) =>
  inspect(input.streamUrl).pipe(
    Effect.flatMap((inspection) =>
      completedWaitForScenario(inspection, input.runId, input.permissionId)
        ? Effect.succeed(inspection)
        : Effect.fail(new ScenarioNotReady({ reason: "not terminal yet" }))
    ),
    Effect.retry({
      times: 80,
      schedule: Schedule.spaced("100 millis"),
    }),
  )

export const selfTestWaitForReceiver = () =>
  withScenarioTestServer(({ streamUrl }) =>
    Effect.gen(function* () {
      const runId = `run-wait-for-receiver-${crypto.randomUUID()}`
      const eventId = `event-permission-approved-${crypto.randomUUID()}`
      const permissionId = `permission-${crypto.randomUUID()}`

      const fiber = yield* Effect.forkScoped(runWaitForReceiver(streamUrl))
      yield* Effect.sleep("200 millis")

      yield* appendRows(
        streamUrl,
        makeWaitForScenarioRows({ runId, eventId, permissionId }),
      )

      const completed = yield* waitForCompletedScenario({
        streamUrl,
        runId,
        permissionId,
      })
      yield* Fiber.interrupt(fiber)

      return {
        streamUrl,
        completed,
      } as const
    }),
  )

export const waitForReceiverScenario = defineReceiverScenario({
  kind: "receiver",
  name: "wait-for-receiver",
  run: runWaitForReceiver,
  selfTest: selfTestWaitForReceiver,
})
