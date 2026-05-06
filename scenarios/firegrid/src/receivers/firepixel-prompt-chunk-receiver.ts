import { Firegrid, run } from "@firegrid/runtime"
import {
  ProjectionMatchTrigger,
  RunWait,
  triggerMatchersLayer,
  type TriggerMatcher,
} from "@firegrid/substrate"
import { EventPlane, type PlaneProjectionQuery } from "@firegrid/substrate/event-plane"
import { Effect, Fiber, Layer, Schedule } from "effect"
import { defineReceiverScenario } from "../definition.ts"
import {
  appendRows,
  pollInspection,
  withScenarioTestServer,
} from "../runner.ts"
import {
  FirepixelPlane,
  FirepixelPromptOperation,
  FirepixelPermissionDecision,
  type FirepixelPromptChunk,
  type FirepixelPermissionDecision as FirepixelPermissionDecisionRow,
  type FirepixelPermissionRequest,
  makeFirepixelPromptChunkDecisionRows,
  makeFirepixelPromptChunkScenarioRows,
} from "../emitters/firepixel-prompt-chunk.ts"

interface FirepixelPlaneRows {
  readonly promptChunks: ReadonlyArray<FirepixelPromptChunk>
  readonly permissionRequests: ReadonlyArray<FirepixelPermissionRequest>
  readonly permissionDecisions: ReadonlyArray<FirepixelPermissionDecisionRow>
}

const planeRowsQuery: PlaneProjectionQuery<
  typeof FirepixelPlane.state,
  FirepixelPlaneRows
> = {
  label: "firepixel.rows",
  authority: "observational",
  evaluate: (snapshot) =>
    Effect.succeed({
      promptChunks: Array.from(snapshot.promptChunks.values()) as ReadonlyArray<
        FirepixelPromptChunk
      >,
      permissionRequests: Array.from(
        snapshot.permissionRequests.values(),
      ) as ReadonlyArray<FirepixelPermissionRequest>,
      permissionDecisions: Array.from(
        snapshot.permissionDecisions.values(),
      ) as ReadonlyArray<FirepixelPermissionDecisionRow>,
    }),
}

const readPlaneRows = (streamUrl: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const projection = yield* FirepixelPlane.Projection
      return yield* projection.snapshot(planeRowsQuery)
    }),
  ).pipe(Effect.provide(EventPlane.layer(FirepixelPlane, { streamUrl })))

const pollPlaneRows = (
  streamUrl: string,
  predicate: (rows: FirepixelPlaneRows) => boolean,
  reason: string,
) =>
  readPlaneRows(streamUrl).pipe(
    Effect.filterOrFail(predicate, () => new Error(reason)),
    Effect.retry({
      times: 80,
      schedule: Schedule.spaced("50 millis"),
    }),
  )

const firepixelPermissionMatcher: TriggerMatcher = () =>
  Effect.succeed({ kind: "no-match" })

const permissionIdFromTrigger = (
  trigger: ProjectionMatchTrigger,
): string | undefined => {
  if (trigger.matcherId !== "scenario.firepixel.permission.allowed") {
    return undefined
  }
  const prefix = `${FirepixelPlane.name}:permission:`
  if (!trigger.projectionKey.startsWith(prefix)) return undefined
  return trigger.projectionKey.slice(prefix.length)
}

const permissionDecisionForTrigger = (
  streamUrl: string,
  trigger: ProjectionMatchTrigger,
) => {
  const permissionId = permissionIdFromTrigger(trigger)
  if (permissionId === undefined) {
    return Effect.succeed({ kind: "no-match" as const })
  }
  // client-event-plane-registration.PROJECTION_API.6
  return readPlaneRows(streamUrl).pipe(
    Effect.map((rows) => {
      const decision = rows.permissionDecisions.find((item) =>
        item.permissionId === permissionId &&
        item.decision === "allowed"
      )
      if (decision === undefined) return { kind: "no-match" as const }
      return {
        kind: "match" as const,
        value: decision,
      }
    }),
  )
}

const firepixelPromptRuntime = (streamUrl: string) =>
  Layer.mergeAll(
    // firegrid-runtime-process.SCENARIOS.20
    // client-event-plane-registration.PROJECTION_API.6
    Firegrid.subscribers.projectionMatch({
      evaluate: (_snapshot, trigger) =>
        permissionDecisionForTrigger(streamUrl, trigger),
    }),
    // firegrid-runtime-process.SCENARIOS.20
    // client-event-plane-registration.PRODUCER_API.6
    // client-event-plane-registration.FIREPIXEL_PROFILE.1
    // client-event-plane-registration.FIREPIXEL_PROFILE.2
    Firegrid.handler(FirepixelPromptOperation, (input) =>
      Effect.gen(function* () {
        const producer = yield* FirepixelPlane.Producer
        const wait = yield* RunWait
        yield* producer.emit(
          FirepixelPlane.state.promptChunks.insert({
            value: {
              chunkId: input.chunkId,
              promptId: input.promptId,
              text: input.text,
              sequence: input.sequence,
            },
          }),
          {
            idempotencyKey: input.chunkId,
            correlationId: input.promptId,
          },
        )
        yield* producer.emit(
          FirepixelPlane.state.permissionRequests.insert({
            value: {
              permissionId: input.permissionId,
              promptId: input.promptId,
              reason: "prompt-chunk emission requires permission",
              state: "requested",
            },
          }),
          {
            idempotencyKey: input.permissionId,
            correlationId: input.promptId,
            causationId: input.chunkId,
          },
        )
        const decision = yield* wait.for(input.permissionTrigger, {
          resultSchema: FirepixelPermissionDecision,
        })
        return {
          promptId: input.promptId,
          chunkId: input.chunkId,
          permissionId: input.permissionId,
          decision: decision.decision,
          emitted: true,
        }
      }),
    ),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        EventPlane.layer(FirepixelPlane, { streamUrl }),
        RunWait.layer({ streamUrl }),
        triggerMatchersLayer({
          "scenario.firepixel.permission.allowed": firepixelPermissionMatcher,
        }),
      ),
    ),
  )

const runFirepixelPromptChunkReceiver = (streamUrl: string) =>
  // firegrid-runtime-process.SCENARIOS.20
  // firegrid-runtime-process.RUNTIME_RUN_API.1
  // firegrid-runtime-process.RUNTIME_RUN_API.2
  // firegrid-runtime-process.RUNTIME_RUN_API.3
  // firegrid-runtime-process.RUNTIME_RUN_API.5
  // firegrid-runtime-process.RUNTIME_RUN_API.6
  // firegrid-runtime-process.RUNTIME_RUN_API.8
  // firegrid-runtime-process.RUNTIME_RUN_API.9
  run({
    connection: { streamUrl },
    runtime: firepixelPromptRuntime(streamUrl),
  })

export const selfTestFirepixelPromptChunkReceiver = () =>
  withScenarioTestServer(({ streamUrl }) =>
    Effect.gen(function* () {
      const runId = `run-firepixel-prompt-${crypto.randomUUID()}`
      const promptId = `prompt-${crypto.randomUUID()}`
      const chunkId = `chunk-${crypto.randomUUID()}`
      const permissionId = `permission-${crypto.randomUUID()}`
      const text = "streamed prompt chunk"
      const sequence = 1

      const fiber = yield* Effect.forkScoped(
        runFirepixelPromptChunkReceiver(streamUrl),
      )
      yield* appendRows(
        streamUrl,
        makeFirepixelPromptChunkScenarioRows({
          runId,
          promptId,
          chunkId,
          permissionId,
          text,
          sequence,
        }),
      )
      const beforeDecision = yield* pollPlaneRows(
        streamUrl,
        (rows) =>
          rows.promptChunks.some((row) =>
            row.chunkId === chunkId &&
            row.promptId === promptId
          ) &&
          rows.permissionRequests.some((row) =>
            row.permissionId === permissionId &&
            row.promptId === promptId &&
            row.state === "requested"
          ),
        "Firepixel prompt chunk and permission request not emitted",
      )
      const pending = yield* pollInspection(
        streamUrl,
        (report) => {
          const runValue = report.runs.find((item) => item.runId === runId)
          const completion = report.completions.find((item) =>
            item.completionId === runValue?.blockedOnCompletionId
          )
          return runValue?.state === "blocked" &&
            completion?.kind === "projection_match" &&
            completion.state === "pending" &&
            report.counts.readyWork === 0
        },
        {
          times: 80,
          interval: "50 millis",
          reason: "Firepixel run did not block on pending projection_match",
        },
      )
      yield* appendRows(
        streamUrl,
        makeFirepixelPromptChunkDecisionRows({
          permissionId,
          promptId,
          decision: "allowed",
        }),
      )

      const completed = yield* pollInspection(
        streamUrl,
        (report) => {
          const pendingRun = pending.runs.find((item) => item.runId === runId)
          const pendingCompletion = pending.completions.find((item) =>
            item.completionId === pendingRun?.blockedOnCompletionId
          )
          const runValue = report.runs.find((item) => item.runId === runId)
          const completion = report.completions.find((item) =>
            item.completionId === pendingCompletion?.completionId
          )
          const projectionMatchCompletions = report.completions.filter(
            (item) => item.kind === "projection_match",
          )
          return runValue !== undefined &&
            runValue.state === "completed" &&
            runValue.blockedOnCompletionId === pendingCompletion?.completionId &&
            (runValue.result as { readonly emitted?: unknown } | undefined)
              ?.emitted === true &&
            (runValue.result as { readonly decision?: unknown } | undefined)
              ?.decision === "allowed" &&
            completion?.kind === "projection_match" &&
            completion.state === "resolved" &&
            projectionMatchCompletions.length === 1 &&
            report.counts.readyWork === 0
        },
        {
          times: 80,
          interval: "50 millis",
          reason: "Firepixel prompt chunk run not completed",
        },
      )
      const afterDecision = yield* pollPlaneRows(
        streamUrl,
        (rows) =>
          rows.permissionDecisions.some((row) =>
            row.permissionId === permissionId &&
            row.promptId === promptId &&
            row.decision === "allowed"
          ),
        "Firepixel permission decision not visible",
      )
      yield* Fiber.interrupt(fiber)

      return {
        streamUrl,
        report: {
          beforeDecision,
          pending,
          completed,
          afterDecision,
        },
      } as const
    }),
  )

export const firepixelPromptChunkReceiverScenario = defineReceiverScenario({
  kind: "receiver",
  name: "firepixel-prompt-chunk-receiver",
  run: runFirepixelPromptChunkReceiver,
  selfTest: selfTestFirepixelPromptChunkReceiver,
  seedRows: () => makeFirepixelPromptChunkDecisionRows(),
})
