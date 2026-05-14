import {
  DurableClock,
  Workflow,
  WorkflowEngine,
} from "@effect/workflow"
import {
  RuntimeIngressTable,
  runtimeIngressInputIdForIdempotencyKey,
  type RuntimeIngressRequest,
} from "@firegrid/protocol/runtime-ingress"
import { Clock, Duration, Effect, Layer, Match, Option, Schema } from "effect"
import type { DurableTableHeaders } from "effect-durable-operators"
import {
  RuntimeHostConfig,
} from "../runtime-host/config.ts"
import {
  appendRuntimeIngress,
} from "../runtime-host/index.ts"
import type {
  RuntimeHostTopologyOptions,
} from "../runtime-host/types.ts"
import {
  DurableStreamsWorkflowEngine,
  WorkflowEngineTable,
} from "../workflow-engine/index.ts"
import {
  RuntimeScheduledInputTable,
  runtimeScheduledInputTableLayerOptions,
  type ScheduledRuntimeInputRow,
} from "./table.ts"

export {
  RuntimeScheduledInputTable,
  type RuntimeScheduledInputTableOptions,
  type RuntimeScheduledInputTableService,
  type ScheduledRuntimeInputRow,
  type ScheduledRuntimeInputStatus,
} from "./table.ts"

export interface ScheduleRuntimeInputRequest {
  readonly scheduleId: string
  readonly contextId: string
  readonly dueAtMs: number
  readonly payload: unknown
  readonly inputId?: string
  readonly idempotencyKey?: string
  readonly metadata?: RuntimeIngressRequest["metadata"]
}

export interface ScheduleRuntimeInputResult {
  readonly schedule: ScheduledRuntimeInputRow
}

interface RuntimeScheduledInputStreamUrls {
  readonly ingressTableUrl: string
  readonly scheduledInputTableUrl: string
  readonly workflowTableUrl: string
}

export class RuntimeScheduledInputError extends Schema.TaggedError<RuntimeScheduledInputError>()(
  "RuntimeScheduledInputError",
  {
    op: Schema.String,
    scheduleId: Schema.optional(Schema.String),
    contextId: Schema.optional(Schema.String),
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

const runtimeScheduledInputError = (
  op: string,
  message: string,
  options?: {
    readonly scheduleId?: string
    readonly contextId?: string
    readonly cause?: unknown
  },
): RuntimeScheduledInputError =>
  new RuntimeScheduledInputError({
    op,
    message,
    ...(options?.scheduleId === undefined ? {} : { scheduleId: options.scheduleId }),
    ...(options?.contextId === undefined ? {} : { contextId: options.contextId }),
    ...(options?.cause === undefined ? {} : { cause: options.cause }),
  })

const nowMs = Clock.currentTimeMillis

const ScheduleRuntimeInputWorkflowPayload = Schema.Struct({
  scheduleId: Schema.String,
})

const ScheduleRuntimeInputWorkflowResult = Schema.Struct({
  scheduleId: Schema.String,
  status: Schema.Literal("pending", "fired"),
  firedInputId: Schema.optional(Schema.String),
})

const scheduleRuntimeInputExecutionId = (scheduleId: string) =>
  `runtime-schedule:${scheduleId}`

const scheduleIdempotencyKey = (scheduleId: string) =>
  `schedule:${scheduleId}`

const scheduledInputId = (
  contextId: string,
  scheduleId: string,
) =>
  runtimeIngressInputIdForIdempotencyKey(
    contextId,
    scheduleIdempotencyKey(scheduleId),
  )

const rowFromRequest = (
  request: ScheduleRuntimeInputRequest,
  createdAtMs: number,
): ScheduledRuntimeInputRow => {
  const idempotencyKey = request.idempotencyKey ?? scheduleIdempotencyKey(request.scheduleId)
  return {
    scheduleId: request.scheduleId,
    contextId: request.contextId,
    dueAtMs: request.dueAtMs,
    status: "pending",
    kind: "message",
    authoredBy: "workflow",
    payload: request.payload,
    inputId: request.inputId ?? scheduledInputId(request.contextId, request.scheduleId),
    idempotencyKey,
    createdAtMs,
    ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
  }
}

const readSchedule = (
  scheduleId: string,
) =>
  Effect.gen(function* () {
    const table = yield* RuntimeScheduledInputTable
    const row = yield* table.scheduledInputs.get(scheduleId).pipe(
      Effect.mapError(cause =>
        runtimeScheduledInputError(
          "schedule.get",
          "failed to read scheduled runtime input",
          { scheduleId, cause },
        )),
    )
    return yield* Option.match(row, {
      onNone: () =>
        Effect.fail(runtimeScheduledInputError(
          "schedule.get",
          "scheduled runtime input not found",
          { scheduleId },
        )),
      onSome: Effect.succeed,
    })
  })

const ScheduleRuntimeInputWorkflow = Workflow.make({
  name: "firegrid.runtime-scheduled-input.input",
  payload: ScheduleRuntimeInputWorkflowPayload,
  success: ScheduleRuntimeInputWorkflowResult,
  error: RuntimeScheduledInputError,
  idempotencyKey: ({ scheduleId }) => scheduleRuntimeInputExecutionId(scheduleId),
})

const ScheduleRuntimeInputWorkflowLayer = ScheduleRuntimeInputWorkflow.toLayer(({ scheduleId }) =>
  Effect.gen(function* () {
    const schedule = yield* readSchedule(scheduleId)
    const currentMs = yield* nowMs
    // firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.1
    // firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.2
    // firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.3
    // firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.4
    yield* DurableClock.sleep({
      name: "due",
      duration: Duration.millis(Math.max(0, schedule.dueAtMs - currentMs)),
      inMemoryThreshold: Duration.zero,
    })

    const latest = yield* readSchedule(scheduleId)
    if (latest.status === "fired") {
      return {
        scheduleId,
        status: "fired" as const,
        ...(latest.firedInputId === undefined ? {} : { firedInputId: latest.firedInputId }),
      }
    }

    const input = yield* appendRuntimeIngress({
      inputId: latest.inputId,
      contextId: latest.contextId,
      kind: latest.kind,
      authoredBy: latest.authoredBy,
      payload: latest.payload,
      ...(latest.idempotencyKey === undefined ? {} : { idempotencyKey: latest.idempotencyKey }),
      ...(latest.metadata === undefined ? {} : { metadata: latest.metadata }),
    }).pipe(
      Effect.mapError(cause =>
        runtimeScheduledInputError(
          "schedule.append-input",
          "failed to append scheduled runtime input",
          {
            scheduleId,
            contextId: latest.contextId,
            cause,
          },
        )),
    )

    const firedAtMs = yield* nowMs
    const fired = {
      ...latest,
      status: "fired" as const,
      firedAtMs,
      firedInputId: input.inputId,
    }
    const table = yield* RuntimeScheduledInputTable
    // firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.5
    // firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.6
    yield* table.scheduledInputs.upsert(fired).pipe(
      Effect.mapError(cause =>
        runtimeScheduledInputError(
          "schedule.mark-fired",
          "failed to mark scheduled runtime input fired",
          {
            scheduleId,
            contextId: latest.contextId,
            cause,
          },
        )),
    )
    return {
      scheduleId,
      status: "fired" as const,
      firedInputId: input.inputId,
    }
  }))

const trimRightSlash = (value: string): string => value.replace(/\/+$/, "")

const streamUrlsFromOptions = (
  options: RuntimeHostTopologyOptions,
): RuntimeScheduledInputStreamUrls => {
  const base = trimRightSlash(options.durableStreamsBaseUrl)
  const streamPrefix = base.includes("/v1/stream/")
    ? `${base}/`
    : `${base}/v1/stream/`
  const streamUrl = (name: string): string =>
    `${streamPrefix}${encodeURIComponent(`${options.namespace}.${name}`)}`
  return {
    ingressTableUrl: streamUrl("firegrid.runtimeIngress"),
    scheduledInputTableUrl: streamUrl(RuntimeScheduledInputTable.namespace),
    workflowTableUrl: streamUrl(WorkflowEngineTable.namespace),
  }
}

const runtimeScheduledInputBaseLayer = (
  options: RuntimeHostTopologyOptions,
) => {
  const urls = streamUrlsFromOptions(options)
  const headers: DurableTableHeaders | undefined = options.headers
  return Layer.mergeAll(
    Layer.succeed(RuntimeHostConfig, {
      inputEnabled: true,
    }),
    RuntimeIngressTable.layer({
      streamOptions: {
        url: urls.ingressTableUrl,
        contentType: "application/json",
        ...(headers === undefined ? {} : { headers }),
      },
    }),
    RuntimeScheduledInputTable.layer(runtimeScheduledInputTableLayerOptions({
      streamUrl: urls.scheduledInputTableUrl,
      ...(headers === undefined ? {} : { headers }),
    })),
    DurableStreamsWorkflowEngine.layer({
      streamUrl: urls.workflowTableUrl,
      ...(headers === undefined ? {} : { headers }),
    }),
  )
}

export const RuntimeScheduledInputLive = (
  options: RuntimeHostTopologyOptions,
) =>
  ScheduleRuntimeInputWorkflowLayer.pipe(
    Layer.provideMerge(runtimeScheduledInputBaseLayer(options)),
  )

export const scheduleRuntimeInput = Effect.fnUntraced(
  function*(request: ScheduleRuntimeInputRequest) {
    const table = yield* RuntimeScheduledInputTable
    const createdAtMs = yield* nowMs
    const proposed = rowFromRequest(request, createdAtMs)
    const insertResult = yield* table.scheduledInputs.insertOrGet(proposed).pipe(
      Effect.mapError(cause =>
        runtimeScheduledInputError(
          "schedule.insert",
          "failed to insert scheduled runtime input",
          {
            scheduleId: request.scheduleId,
            contextId: request.contextId,
            cause,
          },
        )),
    )
    const schedule = Match.value(insertResult).pipe(
      Match.tag("Inserted", () => proposed),
      Match.tag("Found", ({ row }) => row),
      Match.exhaustive,
    )

    const engine = yield* WorkflowEngine.WorkflowEngine
    // firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.5
    // firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.7
    yield* engine.execute(ScheduleRuntimeInputWorkflow, {
      executionId: scheduleRuntimeInputExecutionId(request.scheduleId),
      payload: {
        scheduleId: request.scheduleId,
      },
      discard: true,
    }).pipe(
      Effect.mapError(cause =>
        runtimeScheduledInputError(
          "schedule.workflow",
          "failed to start scheduled runtime input workflow",
          {
            scheduleId: request.scheduleId,
            contextId: schedule.contextId,
            cause,
          },
        )),
    )

    return { schedule } satisfies ScheduleRuntimeInputResult
  },
)
