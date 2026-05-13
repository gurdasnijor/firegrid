import { NodeContext } from "@effect/platform-node"
import {
  Activity,
  Workflow,
  WorkflowEngine,
} from "@effect/workflow"
import {
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  type RuntimeContext,
  type RuntimeEventRow,
  type RuntimeLogLineRow,
} from "@firegrid/protocol/launch"
import {
  RuntimeIngressTable,
  makeRuntimeIngressInputRow,
  type RuntimeIngressRequest,
} from "@firegrid/protocol/runtime-ingress"
import { Clock, Config, Effect, Layer, Option, Redacted, Schema, Stream } from "effect"
import type { DurableTableHeaders } from "effect-durable-operators"
import {
  LocalProcessSandboxProvider,
  commandForContext,
  localProcessStdinDelivery,
  streamSandboxProcess,
  type ProcessOutputChunk,
  type SandboxProviderError,
} from "../providers/sandboxes/index.ts"
import {
  RuntimeIngressError,
  RuntimeContextError,
  asRuntimeContextError,
  mapRuntimeContextError,
  runtimeIngressError,
} from "./errors.ts"
import { RuntimeHostConfig } from "./config.ts"
import {
  DurableStreamsWorkflowEngine,
  WorkflowEngineTable,
} from "../workflow-engine/DurableStreamsWorkflowEngine.ts"
import type {
  RuntimeHostConfigValue,
  RuntimeHostTopologyOptions,
  StartRuntimeOptions,
} from "./types.ts"

export type {
  RuntimeHostTopologyOptions,
  StartRuntimeOptions,
  StartRuntimeResult,
} from "./types.ts"

export {
  RuntimeIngressError,
}

type SequencedChunk = {
  readonly sequence: number
  readonly chunk: ProcessOutputChunk
}

type RuntimeOutputRow = RuntimeEventRow | RuntimeLogLineRow

const RuntimeContextWorkflowPayload = Schema.Struct({
  contextId: Schema.String,
})

const RuntimeExitEvidence = Schema.Struct({
  exitCode: Schema.Number,
  signal: Schema.optional(Schema.String),
})

const StartRuntimeResultSchema = Schema.Struct({
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  exitCode: Schema.Number,
  signal: Schema.optional(Schema.String),
})

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map(millis => new Date(millis).toISOString()),
)

const localProcessStdinSubscriberId = "runtime-context:local-process:stdin"

const runtimeContextWorkflowExecutionId = (contextId: string) =>
  `runtime-context:${contextId}`

const runtimeExecutionClock = Clock.make()

const outputRowFromProcessChunk = (
  context: RuntimeContext,
  activityAttempt: number,
  sequence: number,
  chunk: Extract<ProcessOutputChunk, { readonly type: "output" }>,
): Effect.Effect<RuntimeOutputRow, RuntimeContextError> =>
  Effect.gen(function* () {
    const rule = context.runtime.journal.find(candidate => candidate.source === chunk.channel)
    if (rule === undefined) {
      return yield* Effect.fail(asRuntimeContextError(
        "runtime-output.no-journal-rule",
        `no runtime journal rule for ${chunk.channel}`,
        context.contextId,
      ))
    }

    const receivedAt = yield* nowIso
    if (rule.target === "events" && rule.format === "jsonl" && chunk.channel === "stdout") {
      return {
        eventId: {
          contextId: context.contextId,
          activityAttempt,
          target: "events",
          sequence,
        },
        contextId: context.contextId,
        activityAttempt,
        sequence,
        source: "stdout",
        format: "jsonl",
        receivedAt,
        raw: chunk.text,
      }
    }

    if (rule.target === "logs" && rule.format === "text-lines" && chunk.channel === "stderr") {
      return {
        logLineId: {
          contextId: context.contextId,
          activityAttempt,
          target: "logs",
          sequence,
        },
        contextId: context.contextId,
        activityAttempt,
        sequence,
        source: "stderr",
        format: "text-lines",
        receivedAt,
        raw: chunk.text,
      }
    }

    return yield* Effect.fail(asRuntimeContextError(
      "runtime-output.invalid-journal-rule",
      `unsupported runtime journal rule ${rule.source}:${rule.format}->${rule.target}`,
      context.contextId,
    ))
  })

const readRuntimeContext = (
  contextId: string,
) =>
  Effect.gen(function* () {
    const table = yield* RuntimeControlPlaneTable
    const maybeContext = yield* table.contexts.get(contextId).pipe(
      mapRuntimeContextError(
        "runtime-control-plane.contexts.get",
        "failed to read runtime context row",
        contextId,
      ),
    )
    return yield* Option.match(maybeContext, {
      onNone: () =>
        Effect.fail(asRuntimeContextError(
          "runtime-control-plane.contexts.get",
          `runtime context not found: ${contextId}`,
          contextId,
        )),
      onSome: row => Effect.succeed(row),
    })
  })

const allocateRuntimeActivityAttempt = (
  context: RuntimeContext,
) =>
  // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.2
  Effect.flatMap(RuntimeControlPlaneTable, table =>
    table.runs.query((coll) => {
      const rows = coll.toArray.filter(row => row.contextId === context.contextId)
      const terminalAttempts = new Set(
        rows
          .filter(row => row.status === "exited" || row.status === "failed")
          .map(row => row.activityAttempt),
      )
      const inProgress = rows
        .filter(row => row.status === "started" && !terminalAttempts.has(row.activityAttempt))
        .map(row => row.activityAttempt)
        .sort((left, right) => left - right)[0]
      return inProgress ?? rows.reduce((max, row) => Math.max(max, row.activityAttempt + 1), 1)
    })).pipe(
      mapRuntimeContextError(
        "runtime-control-plane.runs.allocate-attempt",
        "failed to allocate runtime activity attempt",
        context.contextId,
      ),
    )

const writeRunStarted = (
  context: RuntimeContext,
  activityAttempt: number,
) =>
  Effect.gen(function* () {
    const table = yield* RuntimeControlPlaneTable
    const startedAt = yield* nowIso
    yield* table.runs.upsert({
      runEventId: {
        contextId: context.contextId,
        activityAttempt,
        status: "started",
      },
      contextId: context.contextId,
      activityAttempt,
      provider: context.runtime.provider,
      status: "started",
      at: startedAt,
    }).pipe(
      mapRuntimeContextError(
        "runtime-control-plane.runs.started",
        "failed to append runtime started row",
        context.contextId,
      ),
    )
  })

const writeRunExited = (
  context: RuntimeContext,
  activityAttempt: number,
  exit: Schema.Schema.Type<typeof RuntimeExitEvidence>,
) =>
  Effect.gen(function* () {
    const table = yield* RuntimeControlPlaneTable
    const exitedAt = yield* nowIso
    yield* table.runs.upsert({
      runEventId: {
        contextId: context.contextId,
        activityAttempt,
        status: "exited",
      },
      contextId: context.contextId,
      activityAttempt,
      status: "exited",
      provider: context.runtime.provider,
      at: exitedAt,
      exitCode: exit.exitCode,
      ...(exit.signal === undefined ? {} : { signal: exit.signal }),
    }).pipe(
      mapRuntimeContextError(
        "runtime-control-plane.runs.exited",
        "failed to append runtime exited row",
        context.contextId,
      ),
    )
  })

const writeRunFailed = (
  context: RuntimeContext,
  activityAttempt: number,
  message: string,
) =>
  Effect.gen(function* () {
    const table = yield* RuntimeControlPlaneTable
    const failedAt = yield* nowIso
    yield* table.runs.upsert({
      runEventId: {
        contextId: context.contextId,
        activityAttempt,
        status: "failed",
      },
      contextId: context.contextId,
      activityAttempt,
      status: "failed",
      provider: context.runtime.provider,
      message,
      at: failedAt,
    }).pipe(
      mapRuntimeContextError(
        "runtime-control-plane.runs.failed",
        "failed to append runtime failed row",
        context.contextId,
      ),
    )
  })

const runRuntimeContext = (
  context: RuntimeContext,
  activityAttempt: number,
) =>
  // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.3
  // firegrid-workflow-driven-runtime.BOUNDARIES.1
  Effect.gen(function* () {
    const hostConfig = yield* RuntimeHostConfig
    const outputTable = yield* RuntimeOutputTable
    const writeOutputChunk = (
      sequence: number,
      chunk: Extract<ProcessOutputChunk, { readonly type: "output" }>,
    ) =>
      outputRowFromProcessChunk(context, activityAttempt, sequence, chunk).pipe(
        Effect.flatMap(row =>
          row.source === "stdout"
            ? outputTable.events.upsert(row)
            : outputTable.logs.upsert(row)),
        mapRuntimeContextError(
          "runtime-output.write",
          "failed to write runtime data-plane row",
          context.contextId,
        ),
      )

    const command = yield* commandForContext(context)
    const ingressTable = yield* RuntimeIngressTable
    const stdin = hostConfig.inputEnabled
      ? localProcessStdinDelivery({
        contextId: context.contextId,
        subscriberId: localProcessStdinSubscriberId,
      }).pipe(
        // firegrid-workflow-driven-runtime.BOUNDARIES.5
        Stream.mapError(cause =>
          asRuntimeContextError(
            `runtime-ingress.${cause.op}`,
            cause.message,
            context.contextId,
            cause,
          )),
        Stream.provideService(RuntimeIngressTable, ingressTable),
      )
      : undefined

    return yield* streamSandboxProcess({
      labels: {
        firegridRuntimeContextId: context.contextId,
      },
      ...(context.runtime.config.cwd === undefined ? {} : { workingDir: context.runtime.config.cwd }),
      providerConfig: {
        contextId: context.contextId,
      },
      command: {
        ...command,
        ...(stdin === undefined ? {} : { stdin }),
      },
    }).pipe(
      Stream.mapError((cause: SandboxProviderError) =>
        asRuntimeContextError(`sandbox.${cause.op}`, cause.message, context.contextId, cause)),
      Stream.mapAccum(0, (sequence, chunk): readonly [number, SequencedChunk] => [
        sequence + 1,
        { sequence, chunk },
      ]),
      Stream.tap(({ chunk, sequence }) =>
        chunk.type === "exit"
          ? Effect.void
          // firegrid-durable-launch-runtime-operator.JOURNAL_ROWS.7
          : writeOutputChunk(sequence, chunk)),
      Stream.filter((item): item is SequencedChunk & {
        readonly sequence: number
        readonly chunk: Extract<ProcessOutputChunk, { readonly type: "exit" }>
      } => item.chunk.type === "exit"),
      Stream.runHead,
      Effect.flatMap(Option.match({
        onNone: () =>
          Effect.fail(asRuntimeContextError(
            "sandbox.stream",
            "process stream ended without an exit chunk",
            context.contextId,
          )),
        onSome: ({ chunk }) =>
          Effect.succeed({
            exitCode: chunk.exitCode,
            ...(chunk.signal === undefined ? {} : { signal: chunk.signal }),
          }),
      })),
    )
  })

const runRuntimeContextActivity = (
  context: RuntimeContext,
  activityAttempt: number,
) =>
  Activity.make({
    name: "firegrid.runtime-context.run",
    success: RuntimeExitEvidence,
    error: RuntimeContextError,
    execute: runRuntimeContext(context, activityAttempt),
  })

const RuntimeContextWorkflow = Workflow.make({
  name: "firegrid.runtime-context",
  payload: RuntimeContextWorkflowPayload,
  success: StartRuntimeResultSchema,
  error: RuntimeContextError,
  idempotencyKey: ({ contextId }) => runtimeContextWorkflowExecutionId(contextId),
})

const failAfterWritingRunFailed = (
  context: RuntimeContext,
  activityAttempt: number,
) =>
(error: RuntimeContextError) =>
  Effect.gen(function* () {
    yield* writeRunFailed(context, activityAttempt, error.message)
    return yield* Effect.fail(error)
  })

const RuntimeContextWorkflowLayer = RuntimeContextWorkflow.toLayer(({ contextId }) =>
  Effect.gen(function* () {
    // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.2
    const context = yield* readRuntimeContext(contextId)
    const activityAttempt = yield* allocateRuntimeActivityAttempt(context)
    yield* writeRunStarted(context, activityAttempt)
    const exit = yield* runRuntimeContextActivity(context, activityAttempt).pipe(
      Effect.catchAll(failAfterWritingRunFailed(context, activityAttempt)),
    )
    yield* writeRunExited(context, activityAttempt, exit).pipe(
      Effect.catchAll(failAfterWritingRunFailed(context, activityAttempt)),
    )
    return {
      contextId: context.contextId,
      activityAttempt,
      exitCode: exit.exitCode,
      ...(exit.signal === undefined ? {} : { signal: exit.signal }),
    }
  }))

const runtimeHostLayerFromOptions = (
  options: RuntimeHostConfigValue,
  controlPlaneTableUrl: string,
  ingressTableUrl: string,
  outputTableUrl: string,
  headers: DurableTableHeaders | undefined,
) =>
  Layer.mergeAll(
    Layer.succeed(RuntimeHostConfig, options),
    RuntimeControlPlaneTable.layer({
      streamOptions: {
        url: controlPlaneTableUrl,
        contentType: "application/json",
        ...(headers !== undefined ? { headers } : {}),
      },
    }),
    RuntimeIngressTable.layer({
      streamOptions: {
        url: ingressTableUrl,
        contentType: "application/json",
        ...(headers !== undefined ? { headers } : {}),
      },
    }),
    RuntimeOutputTable.layer({
      streamOptions: {
        url: outputTableUrl,
        contentType: "application/json",
        ...(headers !== undefined ? { headers } : {}),
      },
    }),
    LocalProcessSandboxProvider.layer().pipe(
      Layer.provide(NodeContext.layer),
    ),
  )

const runtimeHostStreamUrls = (
  options: RuntimeHostTopologyOptions,
) => {
  const base = options.durableStreamsBaseUrl.replace(/\/+$/, "")
  const streamPrefix = base.includes("/v1/stream/")
    ? `${base}/`
    : `${base}/v1/stream/`
  return {
    controlPlaneTableUrl: `${streamPrefix}${encodeURIComponent(`${options.namespace}.firegrid.runtime`)}`,
    ingressTableUrl: `${streamPrefix}${encodeURIComponent(`${options.namespace}.firegrid.runtimeIngress`)}`,
    outputTableUrl: `${streamPrefix}${encodeURIComponent(`${options.namespace}.firegrid.runtimeOutput`)}`,
    workflowTableUrl: `${streamPrefix}${encodeURIComponent(`${options.namespace}.${WorkflowEngineTable.namespace}`)}`,
  }
}

const runtimeHostBaseLayer = (
  options: RuntimeHostTopologyOptions,
) => {
  const urls = runtimeHostStreamUrls(options)
  return runtimeHostLayerFromOptions({
    // firegrid-agent-ingress.HOST.7
    inputEnabled: options.input === true,
  }, urls.controlPlaneTableUrl, urls.ingressTableUrl, urls.outputTableUrl, options.headers)
}

const runtimeContextWorkflowEngineLayer = (
  options: RuntimeHostTopologyOptions,
) => {
  const { workflowTableUrl } = runtimeHostStreamUrls(options)
  return DurableStreamsWorkflowEngine.layer({
    streamUrl: workflowTableUrl,
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
  })
}

export const FiregridRuntimeHostLive = (
  options: RuntimeHostTopologyOptions,
) =>
  RuntimeContextWorkflowLayer.pipe(
    Layer.provideMerge(Layer.merge(runtimeHostBaseLayer(options), runtimeContextWorkflowEngineLayer(options))),
  )

export const FiregridRuntimeHostWithWorkflowLive = (
  options: RuntimeHostTopologyOptions,
) => FiregridRuntimeHostLive(options)

export const RuntimeHostTopologyFromConfig = Config.all({
  durableStreamsBaseUrl: Config.string("DURABLE_STREAMS_BASE_URL"),
  namespace: Config.string("FIREGRID_RUNTIME_NAMESPACE"),
  input: Config.boolean("FIREGRID_RUNTIME_INPUT_ENABLED").pipe(
    Config.withDefault(false),
  ),
  token: Config.option(Config.redacted("FIREGRID_DURABLE_STREAMS_TOKEN")),
}).pipe(
  Config.map(({ durableStreamsBaseUrl, namespace, input, token }) => {
    const headers = Option.match(token, {
      onNone: () => undefined,
      onSome: (redacted) => ({
        Authorization: () => `Bearer ${Redacted.value(redacted)}`,
      }) satisfies DurableTableHeaders,
    })
    return {
      durableStreamsBaseUrl,
      namespace,
      input,
      ...(headers !== undefined ? { headers } : {}),
    }
  }),
)

export const FiregridRuntimeHostFromConfig = Layer.unwrapEffect(
  Effect.map(RuntimeHostTopologyFromConfig, FiregridRuntimeHostLive),
)

export const FiregridRuntimeHostWithWorkflowFromConfig = Layer.unwrapEffect(
  Effect.map(RuntimeHostTopologyFromConfig, FiregridRuntimeHostWithWorkflowLive),
)

export const startRuntime = (
  options: StartRuntimeOptions,
) =>
  // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.1
  // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.4
  Effect.flatMap(WorkflowEngine.WorkflowEngine, engine =>
    engine.execute(RuntimeContextWorkflow, {
      executionId: runtimeContextWorkflowExecutionId(options.contextId),
      payload: RuntimeContextWorkflowPayload.make({
        contextId: options.contextId,
      }),
    })).pipe(
      Effect.withClock(runtimeExecutionClock),
    )

export const appendRuntimeIngress = (
  request: RuntimeIngressRequest,
) =>
  Effect.gen(function* () {
    const options = yield* RuntimeHostConfig
    if (!options.inputEnabled) {
      return yield* runtimeIngressError(
        "append",
        "runtime ingress table is not configured",
        request.contextId,
        request.inputId,
      )
    }
    const table = yield* RuntimeIngressTable
    const row = makeRuntimeIngressInputRow(request)
    const existing = yield* table.inputs.get(row.inputId).pipe(
      Effect.mapError(cause =>
        runtimeIngressError(
          "append",
          "failed to read runtime ingress durable row",
          row.contextId,
          row.inputId,
          cause,
        )),
    )
    if (Option.isSome(existing)) {
      return existing.value
    }

    // firegrid-agent-ingress.INGRESS.9
    const nextSequence = yield* table.inputs.query((coll) =>
      coll.toArray
        .filter(candidate => candidate.contextId === row.contextId)
        .reduce(
          (max, candidate) =>
            candidate.sequence === undefined ? max : Math.max(max, candidate.sequence + 1),
          0,
        ),
    ).pipe(
      Effect.mapError(cause =>
        runtimeIngressError(
          "append",
          "failed to query runtime ingress durable rows",
          row.contextId,
          row.inputId,
          cause,
        )),
    )
    const sequenced = {
      ...row,
      status: "sequenced" as const,
      sequence: nextSequence,
      sequencedAt: yield* nowIso,
    }
    // firegrid-agent-ingress.INGRESS.10
    yield* table.inputs.insert(sequenced).pipe(
      Effect.mapError(cause =>
        runtimeIngressError(
          "append",
          "failed to append runtime ingress durable row",
          row.contextId,
          row.inputId,
          cause,
        )),
    )
    return sequenced
  })
