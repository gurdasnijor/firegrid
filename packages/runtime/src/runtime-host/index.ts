import { Prompt } from "@effect/ai"
import { NodeContext } from "@effect/platform-node"
import {
  Activity,
  Workflow,
  WorkflowEngine,
} from "@effect/workflow"
import {
  HostIdSegmentSchema,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  type RuntimeAgentProtocol,
  local,
  makeHostSessionRow,
  normalizeRuntimeIntent,
  type HostId,
  type HostSessionRow,
  type HostSessionId,
  type RuntimeContext,
  type RuntimeEventRow,
  type RuntimeLogLineRow,
} from "@firegrid/protocol/launch"
import {
  RuntimeIngressTable,
  makeRuntimeIngressInputRow,
  nextRuntimeIngressSequence,
  type RuntimeIngressInputRow,
  type RuntimeIngressRequest,
} from "@firegrid/protocol/runtime-ingress"
import { Clock, Config, Effect, Either, Layer, Option, Redacted, Ref, Schema, Stream } from "effect"
import type { DurableTableHeaders } from "effect-durable-operators"
import {
  CurrentHostSession,
  CurrentRuntimeContext,
  findRuntimeContext,
  hostOwnedStreamUrl,
  insertLocalRuntimeContext,
  provideRuntimeContext,
  requireLocalContext,
  runtimeControlPlaneStreamUrl,
} from "./host-context-authority.ts"
import { executeRuntimeContextWorkflow } from "./internal/run-context-workflow.ts"
import {
  LocalProcessSandboxProvider,
  RuntimeEnvResolverPolicy,
  SandboxProvider,
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
import { DurableStreamsWorkflowEngine } from "../workflow-engine/DurableStreamsWorkflowEngine.ts"
import type {
  RuntimeHostTopologyOptions,
  StartRuntimeOptions,
} from "./types.ts"
import {
  AgentToolHost,
  type AgentToolHostService,
} from "../agent-tools/tool-host.ts"
import { FiregridAgentToolkit } from "../agent-tools/tools.ts"
import { ScheduledInputWorkflowLayer } from "../agent-tools/scheduled-input-workflow.ts"
import { toolUseToEffect } from "../agent-tools/tool-use-to-effect.ts"
import { toolExecutionFailed } from "../agent-tools/tool-error.ts"
import { DurableToolsWaitForLive } from "../durable-tools/DurableToolsWaitFor.ts"
import {
  AcpCodec,
  StdioJsonlCodec,
} from "../agent-codecs/index.ts"
import {
  AgentInputEventSchema,
  AgentOutputEventSchema,
  type AgentCodec,
  type AgentByteStream,
  type AgentInputEvent,
  type AgentOutputEvent,
} from "../agent-io/index.ts"

export type {
  RuntimeHostTopologyOptions,
  StartRuntimeOptions,
  StartRuntimeResult,
} from "./types.ts"

export {
  ContextNotFound,
  ContextNotLocal,
  CurrentHostSession,
  CurrentHostStopped,
  CurrentRuntimeContext,
  durableStreamUrl,
  findRuntimeContext,
  hostOwnedStreamUrl,
  insertLocalRuntimeContext,
  provideRuntimeContext,
  requireLocalContext,
  runtimeControlPlaneStreamUrl,
} from "./host-context-authority.ts"

export {
  RuntimeIngressError,
}
export {
  localProcessSpawnEnvFromHostEnv,
  type LocalProcessSandboxProviderOptions,
} from "../providers/sandboxes/local-process.ts"

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

const agentProtocolForContext = (
  context: RuntimeContext,
): RuntimeAgentProtocol => context.runtime.config.agentProtocol ?? "raw"

const codecForAgentProtocol = (
  protocol: Exclude<RuntimeAgentProtocol, "raw">,
): AgentCodec => {
  switch (protocol) {
    case "stdio-jsonl":
      return StdioJsonlCodec
    case "acp":
      return AcpCodec
    default:
      return protocol satisfies never
  }
}

const codecSupportsToolResultInput = (
  protocol: Exclude<RuntimeAgentProtocol, "raw">,
): boolean => protocol === "stdio-jsonl"

const agentCodecSubscriberId = (
  protocol: Exclude<RuntimeAgentProtocol, "raw">,
) => `runtime-context:${protocol}:codec`

const runtimeOutputRawFromAgentEvent = (
  contextId: string,
  event: AgentOutputEvent,
): Effect.Effect<string, RuntimeContextError> =>
  Effect.try({
    try: () =>
      JSON.stringify({
        type: "firegrid.agent-output",
        event: Schema.encodeUnknownSync(AgentOutputEventSchema)(event),
      }),
    catch: cause =>
      asRuntimeContextError(
        "runtime-output.agent-event.encode",
        "failed to encode agent output event",
        contextId,
        cause,
      ),
  })

const outputRowFromAgentEvent = (
  context: RuntimeContext,
  activityAttempt: number,
  sequence: number,
  event: AgentOutputEvent,
): Effect.Effect<RuntimeEventRow, RuntimeContextError> =>
  Effect.gen(function* () {
    const receivedAt = yield* nowIso
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
      raw: yield* runtimeOutputRawFromAgentEvent(context.contextId, event),
    }
  })

const logLineRowFromCodecStderr = (
  context: RuntimeContext,
  activityAttempt: number,
  sequence: number,
  raw: string,
): Effect.Effect<RuntimeLogLineRow, RuntimeContextError> =>
  Effect.gen(function* () {
    const receivedAt = yield* nowIso
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
      raw,
    }
  })

const textFromIngressPayload = (payload: unknown): string | undefined => {
  if (typeof payload === "string") return payload
  if (typeof payload !== "object" || payload === null) return undefined
  const record = payload as Record<string, unknown>
  return record.type === "text" && typeof record.text === "string"
    ? record.text
    : undefined
}

const promptFromIngressPayload = (
  row: RuntimeIngressInputRow,
): Effect.Effect<AgentInputEvent, RuntimeContextError> => {
  const text = textFromIngressPayload(row.payload)
  if (text !== undefined) {
    return Effect.succeed({
      _tag: "Prompt",
      correlationId: row.inputId,
      prompt: Prompt.userMessage({
        content: [Prompt.textPart({ text })],
      }),
    })
  }
  return Schema.decodeUnknown(Prompt.UserMessage)(row.payload).pipe(
    Effect.map(prompt => ({
      _tag: "Prompt" as const,
      correlationId: row.inputId,
      prompt,
    })),
    Effect.mapError(cause =>
      asRuntimeContextError(
        "runtime-ingress.codec.decode",
        "runtime message ingress payload is not an AgentInputEvent, text payload, or Prompt.UserMessage",
        row.contextId,
        cause,
      )),
  )
}

const inputEventFromIngressRow = (
  row: RuntimeIngressInputRow,
): Effect.Effect<AgentInputEvent, RuntimeContextError> => {
  const decoded = Schema.decodeUnknownEither(AgentInputEventSchema)(row.payload)
  if (Either.isRight(decoded)) return Effect.succeed(decoded.right)

  if (row.kind === "message") return promptFromIngressPayload(row)

  if (row.kind === "tool_result") {
    return Schema.decodeUnknown(Prompt.ToolResultPart)(row.payload).pipe(
      Effect.map(part => ({ _tag: "ToolResult" as const, part })),
      Effect.mapError(cause =>
        asRuntimeContextError(
          "runtime-ingress.codec.decode",
          "runtime tool_result ingress payload is not an AgentInputEvent or Prompt.ToolResultPart",
          row.contextId,
          cause,
        )),
    )
  }

  return Effect.fail(asRuntimeContextError(
    "runtime-ingress.codec.decode",
    `runtime ${row.kind} ingress payload is not an AgentInputEvent`,
    row.contextId,
    decoded.left,
  ))
}

const sequencedCodecIngressRows = (
  table: RuntimeIngressTable["Type"],
  contextId: string,
): Stream.Stream<RuntimeIngressInputRow, RuntimeContextError> =>
  table.inputs.rows().pipe(
    Stream.filter(row =>
      row.contextId === contextId &&
      row.status === "sequenced" &&
      row.sequence !== undefined,
    ),
    Stream.mapError(cause =>
      asRuntimeContextError(
        "runtime-ingress.codec.subscribe",
        "failed to subscribe to runtime ingress rows",
        contextId,
        cause,
      )),
  )

const agentCodecIngressDelivery = (
  table: RuntimeIngressTable["Type"],
  options: {
  readonly contextId: string
  readonly subscriberId: string
},
): Stream.Stream<AgentInputEvent, RuntimeContextError> =>
  sequencedCodecIngressRows(table, options.contextId).pipe(
    Stream.mapEffect(row =>
      Effect.gen(function* () {
        const key = {
          subscriberId: options.subscriberId,
          inputId: row.inputId,
        }
        const existing = yield* table.deliveries.get(key).pipe(
          mapRuntimeContextError(
            "runtime-ingress.codec.delivery.get",
            "failed to read runtime codec delivery row",
            options.contextId,
          ),
        )
        if (
          Option.isSome(existing) &&
          existing.value.claimedAt !== undefined
        ) {
          return Option.none<AgentInputEvent>()
        }

        yield* table.deliveries.upsert({
          key,
          inputId: row.inputId,
          contextId: row.contextId,
          subscriberId: options.subscriberId,
          claimedAt: yield* nowIso,
        }).pipe(
          mapRuntimeContextError(
            "runtime-ingress.codec.delivery.claim",
            "failed to claim runtime codec delivery row",
            options.contextId,
          ),
        )

        return Option.some(yield* inputEventFromIngressRow(row))
      })),
    Stream.filterMap(value => value),
  )

const codecStderrLines = (
  contextId: string,
  stderr: ReadableStream<Uint8Array>,
): Stream.Stream<string, RuntimeContextError> =>
  Stream.fromReadableStream({
    evaluate: () => stderr,
    onError: cause =>
      asRuntimeContextError(
        "sandbox.codec.stderr",
        "failed reading codec process stderr",
        contextId,
        cause,
      ),
    releaseLockOnEnd: true,
  }).pipe(
    Stream.decodeText(),
    Stream.splitLines,
  )

const writeCodecStderrLogs = (options: {
  readonly context: RuntimeContext
  readonly activityAttempt: number
  readonly bytes: AgentByteStream
  readonly outputTable: RuntimeOutputTable["Type"]
}): Effect.Effect<void, RuntimeContextError> =>
  Effect.gen(function* () {
    const sequenceRef = yield* Ref.make(0)
    yield* codecStderrLines(options.context.contextId, options.bytes.stderr).pipe(
      Stream.mapEffect(line =>
        Effect.gen(function* () {
          const sequence = yield* Ref.getAndUpdate(sequenceRef, value => value + 1)
          const row = yield* logLineRowFromCodecStderr(
            options.context,
            options.activityAttempt,
            sequence,
            line,
          )
          yield* options.outputTable.logs.upsert(row).pipe(
            mapRuntimeContextError(
              "runtime-output.codec.stderr.write",
              "failed to write codec stderr runtime log row",
              options.context.contextId,
            ),
          )
        })),
      Stream.runDrain,
    )
  })

const HostOwnedDurableToolsWaitForLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const session = yield* CurrentHostSession
    const config = yield* RuntimeHostConfig
    return DurableToolsWaitForLive({
      streamUrl: hostOwnedStreamUrl({
        baseUrl: config.durableStreamsBaseUrl,
        prefix: session.streamPrefix,
        segment: "durableTools",
      }),
    })
  }),
)

const runtimeCodecToolLoweringLayer = () =>
  Layer.mergeAll(
    RuntimeHostAgentToolHostLive,
    ScheduledInputWorkflowLayer,
    HostOwnedDurableToolsWaitForLive,
  )

const handleAgentOutputEvent = (options: {
  readonly context: RuntimeContext
  readonly protocol: Exclude<RuntimeAgentProtocol, "raw">
  readonly session: { readonly send: (event: AgentInputEvent) => Effect.Effect<void, unknown> }
  readonly event: AgentOutputEvent
}): Effect.Effect<void, RuntimeContextError, unknown> => {
  if (options.event._tag !== "ToolUse") return Effect.void
  if (!codecSupportsToolResultInput(options.protocol)) return Effect.void

  // firegrid-factory-aligned-agent-tools.RUNTIME_CODEC.1
  return toolUseToEffect({ contextId: options.context.contextId }, options.event).pipe(
    Effect.flatMap(toolResult => options.session.send(toolResult)),
    Effect.provide(runtimeCodecToolLoweringLayer()),
    Effect.mapError(cause =>
      asRuntimeContextError(
        "agent-codec.tool-result",
        "failed to lower codec ToolUse or send ToolResult",
        options.context.contextId,
        cause,
      )),
  )
}

const runCodecRuntimeContext = (options: {
  readonly context: RuntimeContext
  readonly activityAttempt: number
  readonly protocol: Exclude<RuntimeAgentProtocol, "raw">
  readonly outputTable: RuntimeOutputTable["Type"]
  readonly ingressTable: RuntimeIngressTable["Type"]
}) =>
  Effect.gen(function* () {
    const codec = codecForAgentProtocol(options.protocol)
    const command = yield* commandForContext(options.context)
    const provider = yield* SandboxProvider
    const sandbox = yield* provider.getOrCreate({
      labels: {
        firegridRuntimeContextId: options.context.contextId,
      },
      ...(options.context.runtime.config.cwd === undefined ? {} : {
        workingDir: options.context.runtime.config.cwd,
      }),
      providerConfig: {
        contextId: options.context.contextId,
      },
    }).pipe(
      Effect.mapError((cause: SandboxProviderError) =>
        asRuntimeContextError(
          `sandbox.${cause.op}`,
          cause.message,
          options.context.contextId,
          cause,
        )),
    )
    const bytes = yield* provider.openBytePipe(sandbox, command).pipe(
      Effect.mapError((cause: SandboxProviderError) =>
        asRuntimeContextError(
          `sandbox.${cause.op}`,
          cause.message,
          options.context.contextId,
          cause,
        )),
    )
    const session = yield* codec.open(bytes, {
      toolkit: FiregridAgentToolkit,
    }).pipe(
      Effect.mapError(cause =>
        asRuntimeContextError(
          `agent-codec.${cause.op}`,
          cause.message,
          options.context.contextId,
          cause,
        )),
    )

    yield* writeCodecStderrLogs({
      context: options.context,
      activityAttempt: options.activityAttempt,
      bytes,
      outputTable: options.outputTable,
    }).pipe(Effect.forkScoped)

    yield* agentCodecIngressDelivery(options.ingressTable, {
      contextId: options.context.contextId,
      subscriberId: agentCodecSubscriberId(options.protocol),
    }).pipe(
      Stream.mapEffect(input =>
        session.send(input).pipe(
          Effect.mapError(cause =>
            asRuntimeContextError(
              "agent-codec.input.send",
              "failed to send runtime ingress input to agent codec",
              options.context.contextId,
              cause,
            )),
        )),
      Stream.runDrain,
      Effect.forkScoped,
    )

    return yield* session.outputs.pipe(
      Stream.mapError(cause =>
        asRuntimeContextError(
          `agent-codec.${cause.op}`,
          cause.message,
          options.context.contextId,
          cause,
        )),
      Stream.mapAccum(0, (sequence, event) => [
        sequence + 1,
        { sequence, event },
      ] as const),
      Stream.tap(({ sequence, event }) =>
        outputRowFromAgentEvent(
          options.context,
          options.activityAttempt,
          sequence,
          event,
        ).pipe(
          Effect.flatMap(row => options.outputTable.events.upsert(row)),
          mapRuntimeContextError(
            "runtime-output.codec.write",
            "failed to write codec runtime output row",
            options.context.contextId,
          ),
        )),
      Stream.tap(({ event }) =>
        handleAgentOutputEvent({
          context: options.context,
          protocol: options.protocol,
          session,
          event,
        })),
      Stream.filter((item): item is {
        readonly sequence: number
        readonly event: Extract<AgentOutputEvent, { readonly _tag: "Terminated" }>
      } => item.event._tag === "Terminated"),
      Stream.runHead,
      Effect.flatMap(Option.match({
        onNone: () =>
          Effect.fail(asRuntimeContextError(
            "agent-codec.outputs",
            "codec output stream ended without a Terminated event",
            options.context.contextId,
          )),
        onSome: ({ event }) =>
          Effect.succeed({
            exitCode: event.exitCode ?? 0,
          }),
      })),
    )
  }).pipe(Effect.scoped)

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

    const ingressTable = yield* RuntimeIngressTable
    const protocol = agentProtocolForContext(context)
    if (protocol !== "raw") {
      return yield* runCodecRuntimeContext({
        context,
        activityAttempt,
        protocol,
        outputTable,
        ingressTable,
      })
    }

    const command = yield* commandForContext(context)
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

// firegrid-host-context-authority.EFFECT_SCOPED_CONTEXT.1
// firegrid-host-context-authority.EFFECT_SCOPED_CONTEXT.2
//
// CurrentHostSession layer for the host scope. The session row carries
// the schema-encoded stream prefix that host-owned ingress / output /
// workflow layers read; long-lived layers see exactly one host
// identity for their lifetime.
// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.3
//
// Host identity is required at the topology type, so this layer is
// never asked to fabricate one. No env, disk, or random fallback —
// the only sanctioned suppliers are direct callers passing
// `options.hostId` and the `FiregridLocalHostLive` helper that
// derives a deterministic per-namespace id.
const currentHostSessionLayer = (
  options: RuntimeHostTopologyOptions,
) =>
  Layer.effect(
    CurrentHostSession,
    Effect.gen(function* () {
      const startedAtMs = yield* Clock.currentTimeMillis
      const hostId = options.hostId as HostId
      const hostSessionId = (options.hostSessionId
        ?? `session-${crypto.randomUUID()}`) as HostSessionId
      return makeHostSessionRow({
        hostId,
        hostSessionId,
        namespace: options.namespace,
        startedAtMs,
      })
    }),
  )

// Namespace-scoped infrastructure: control plane, host config, sandbox
// provider. The RuntimeContext index stays at `{namespace}.firegrid.runtime`
// so cross-host context lookup does not require a host directory.
const namespaceScopedLayer = (
  options: RuntimeHostTopologyOptions,
) =>
  Layer.mergeAll(
    Layer.succeed(RuntimeHostConfig, {
      // firegrid-agent-ingress.HOST.7
      inputEnabled: options.input === true,
      durableStreamsBaseUrl: options.durableStreamsBaseUrl,
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
    }),
    RuntimeControlPlaneTable.layer({
      streamOptions: {
        url: runtimeControlPlaneStreamUrl({
          baseUrl: options.durableStreamsBaseUrl,
          namespace: options.namespace,
        }),
        contentType: "application/json",
        ...(options.headers !== undefined ? { headers: options.headers } : {}),
      },
    }),
    LocalProcessSandboxProvider.layer(options.localProcessEnv).pipe(
      Layer.provide(NodeContext.layer),
    ),
  )

// firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.1
// firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.2
// firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.3
// firegrid-host-context-authority.EFFECT_SCOPED_CONTEXT.2
//
// Host-owned operational tables. Each layer reads CurrentHostSession
// at acquire time and routes its backing stream through the host's
// schema-encoded prefix via `hostOwnedStreamUrl`. Stream URLs are
// derived here, never composed from inline template literals at
// layer call sites.
const hostOwnedIngressLayer = (
  options: { readonly baseUrl: string; readonly headers?: DurableTableHeaders },
) =>
  Layer.unwrapEffect(
    Effect.map(CurrentHostSession, (session) =>
      RuntimeIngressTable.layer({
        streamOptions: {
          url: hostOwnedStreamUrl({
            baseUrl: options.baseUrl,
            prefix: session.streamPrefix,
            segment: "runtimeIngress",
          }),
          contentType: "application/json",
          ...(options.headers !== undefined ? { headers: options.headers } : {}),
        },
      })),
  )

const ownerIngressLayer = (
  options: {
    readonly baseUrl: string
    readonly headers?: DurableTableHeaders
    readonly context: RuntimeContext
  },
) =>
  RuntimeIngressTable.layer({
    streamOptions: {
      url: hostOwnedStreamUrl({
        baseUrl: options.baseUrl,
        prefix: options.context.host.streamPrefix,
        segment: "runtimeIngress",
      }),
      contentType: "application/json",
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
    },
  })

const hostOwnedOutputLayer = (
  options: { readonly baseUrl: string; readonly headers?: DurableTableHeaders },
) =>
  Layer.unwrapEffect(
    Effect.map(CurrentHostSession, (session) =>
      RuntimeOutputTable.layer({
        streamOptions: {
          url: hostOwnedStreamUrl({
            baseUrl: options.baseUrl,
            prefix: session.streamPrefix,
            segment: "runtimeOutput",
          }),
          contentType: "application/json",
          ...(options.headers !== undefined ? { headers: options.headers } : {}),
        },
      })),
  )

const hostOwnedWorkflowEngineLayer = (
  options: { readonly baseUrl: string; readonly headers?: DurableTableHeaders },
) =>
  Layer.unwrapEffect(
    Effect.map(CurrentHostSession, (session) =>
      DurableStreamsWorkflowEngine.layer({
        streamUrl: hostOwnedStreamUrl({
          baseUrl: options.baseUrl,
          prefix: session.streamPrefix,
          segment: "workflow",
        }),
        ...(options.headers !== undefined ? { headers: options.headers } : {}),
      })),
  )

const hostScopedLayer = (
  options: RuntimeHostTopologyOptions,
) => {
  const sharedOptions = {
    baseUrl: options.durableStreamsBaseUrl,
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
  }
  return Layer.mergeAll(
    hostOwnedIngressLayer(sharedOptions),
    hostOwnedOutputLayer(sharedOptions),
    hostOwnedWorkflowEngineLayer(sharedOptions),
  )
}

export const FiregridRuntimeHostLive = (
  options: RuntimeHostTopologyOptions,
  // firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6
  // Default policy denies every env binding ref. Callers that want to
  // authorize specific host env vars (e.g. firegrid:run --secret-env)
  // construct a populated policy at the binary boundary and pass it here;
  // daemons that never see --secret-env stay locked down.
  envPolicy: Layer.Layer<RuntimeEnvResolverPolicy> = RuntimeEnvResolverPolicy.denyAll,
) => {
  const session = currentHostSessionLayer(options)
  const namespaceScoped = namespaceScopedLayer(options)
  const hostScoped = hostScopedLayer(options)
  return RuntimeContextWorkflowLayer.pipe(
    Layer.provideMerge(hostScoped),
    Layer.provideMerge(namespaceScoped),
    Layer.provideMerge(session),
    Layer.provideMerge(envPolicy),
  )
}

export const FiregridRuntimeHostWithWorkflowLive = (
  options: RuntimeHostTopologyOptions,
  envPolicy?: Layer.Layer<RuntimeEnvResolverPolicy>,
) => FiregridRuntimeHostLive(options, envPolicy)

// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.3
// firegrid-host-context-authority.EFFECT_SCOPED_CONTEXT.1
//
// Single production composition for a one-host-per-namespace local
// runtime. The helper owns `CurrentHostSession` internally; callers
// supply only the namespace + base URL + optional headers/input and
// then talk to `Firegrid` / `startRuntime` through the normal public
// surface. Host identity is derived deterministically from the
// namespace, so every process composing this layer with the same
// namespace converges on the same `hostId` — no env knob, no
// filesystem state, no random fallback.
//
// Multi-host topologies (e.g. the two-host workflow stream isolation
// unit test) bypass this helper and pass `hostId` to
// `FiregridRuntimeHostWithWorkflowLive` at the programmatic test
// composition boundary.
//
// `HostStreamPrefixPartsSchema` requires the hostId to be a single
// dot-free segment; namespaces are allowed to contain dots, so the
// derivation replaces `.` with `_` to keep the result schema-valid.
// The derived id is decoded through `HostIdSegmentSchema` — which
// shares its dot-free / non-empty invariants with the prefix
// validator — so a future constraint change here fails loudly at
// composition time rather than at table construction.
const localHostIdForNamespace = (namespace: string): HostId => {
  const sanitized = namespace.replaceAll(".", "_")
  return Schema.decodeUnknownSync(HostIdSegmentSchema)(`${sanitized}-host`)
}

export const FiregridLocalHostLive = (
  options: {
    readonly durableStreamsBaseUrl: string
    readonly namespace: string
    readonly input?: boolean
    readonly headers?: DurableTableHeaders
    readonly localProcessEnv?: RuntimeHostTopologyOptions["localProcessEnv"]
  },
  envPolicy?: Layer.Layer<RuntimeEnvResolverPolicy>,
) => {
  const composed: RuntimeHostTopologyOptions = {
    durableStreamsBaseUrl: options.durableStreamsBaseUrl,
    namespace: options.namespace,
    hostId: localHostIdForNamespace(options.namespace),
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.localProcessEnv === undefined
      ? {}
      : { localProcessEnv: options.localProcessEnv }),
  }
  return FiregridRuntimeHostWithWorkflowLive(composed, envPolicy)
}

// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.3
//
// RuntimeHostTopologyFromConfig reads only the base URL + namespace +
// optional input / token from env. Host identity is NOT an env knob:
// `FiregridRuntimeHostFromConfig` composes the resulting topology
// through `FiregridLocalHostLive`, which owns CurrentHostSession
// internally and derives the host id deterministically from the
// namespace. Multi-host topologies bypass FromConfig entirely and
// supply `hostId` at the programmatic composition boundary via
// `FiregridRuntimeHostWithWorkflowLive`.
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
  Effect.map(RuntimeHostTopologyFromConfig, options => FiregridLocalHostLive(options)),
)

export const FiregridRuntimeHostWithWorkflowFromConfig = Layer.unwrapEffect(
  Effect.map(RuntimeHostTopologyFromConfig, options => FiregridLocalHostLive(options)),
)

// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6
// Variant for callers that want to pass a non-default env resolver policy
// (e.g. firegrid:run, whose --secret-env flag authorizes specific host env
// vars). The policy is constructed at the binary boundary so that
// globalThis.process.env reads stay outside library code.
export const FiregridRuntimeHostWithWorkflowFromConfigWithEnvPolicy = (
  envPolicy: Layer.Layer<RuntimeEnvResolverPolicy>,
) =>
  Layer.unwrapEffect(
    Effect.map(RuntimeHostTopologyFromConfig, options =>
      FiregridLocalHostLive(options, envPolicy)),
  )

export const startRuntime = (
  options: StartRuntimeOptions,
) =>
  // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.1
  // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.4
  // firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.2
  // firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.4
  //
  // requireLocalContext runs before any host-owned services are
  // touched, so a host cannot smuggle execution of a context whose
  // RuntimeContext.host binding names another host. The check uses
  // RuntimeControlPlaneTable + CurrentHostSession from this same host
  // scope; it is not a tool-arg or env-var check.
  Effect.gen(function* () {
    yield* requireLocalContext(options.contextId)
    const engine = yield* WorkflowEngine.WorkflowEngine
    return yield* executeRuntimeContextWorkflow(engine, RuntimeContextWorkflow, {
      executionId: runtimeContextWorkflowExecutionId(options.contextId),
      payload: RuntimeContextWorkflowPayload.make({
        contextId: options.contextId,
      }),
    })
  }).pipe(
    Effect.withClock(runtimeExecutionClock),
  )

export const appendRuntimeIngress = (
  request: RuntimeIngressRequest,
) =>
  Effect.gen(function* () {
    // firegrid-host-context-authority.PROMPT_ROUTING.1
    // firegrid-host-context-authority.PROMPT_ROUTING.2
    //
    // Prompt append is durable routing, not local process execution.
    // Resolve RuntimeContext through the namespace-scoped control
    // plane, then open the owner host's ingress table from
    // RuntimeContext.host. The caller never passes or constructs the
    // owner ingress URL.
    const context = yield* findRuntimeContext(request.contextId).pipe(
      Effect.mapError(cause =>
        runtimeIngressError(
          "append",
          "failed to resolve runtime context for ingress append",
          request.contextId,
          request.inputId,
          cause,
        )),
    )
    const options = yield* RuntimeHostConfig
    return yield* appendRuntimeIngressInCurrentContext(request).pipe(
      provideRuntimeContext(context),
      Effect.provide(ownerIngressLayer({
        baseUrl: options.durableStreamsBaseUrl,
        ...(options.headers !== undefined ? { headers: options.headers } : {}),
        context,
      })),
      Effect.scoped,
    )
  })

const appendRuntimeIngressInCurrentContext = (
  request: RuntimeIngressRequest,
) =>
  Effect.gen(function* () {
    const context = yield* CurrentRuntimeContext
    const table = yield* RuntimeIngressTable
    const row = makeRuntimeIngressInputRow(request)
    if (row.contextId !== context.contextId) {
      return yield* runtimeIngressError(
        "append",
        "runtime ingress request context does not match CurrentRuntimeContext",
        row.contextId,
        row.inputId,
      )
    }
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

    const nextSequence = yield* nextRuntimeIngressSequence(table, row.contextId).pipe(
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

const unsupportedAgentTool = (
  toolUseId: string,
  name: string,
) =>
  Effect.fail(toolExecutionFailed(
    toolUseId,
    name,
    new Error(`${name} is not wired by RuntimeHostAgentToolHostLive in this slice`),
  ))

const childContextIdForToolUse = (
  parentContextId: string,
  toolUseId: string,
) => {
  const segment = `${parentContextId}-${toolUseId}`.replaceAll(
    /[^A-Za-z0-9_-]/g,
    "_",
  )
  return `ctx_${segment}`
}

const sessionNewInputIdForToolUse = (
  childContextId: string,
  toolUseId: string,
) => `session-new:${childContextId}:${toolUseId}`

const runtimeHostAgentToolHostService = (captured: {
  readonly hostConfig: RuntimeHostConfig["Type"]
  readonly controlPlane: RuntimeControlPlaneTable["Type"]
  readonly hostSession: HostSessionRow
  readonly workflowEngine: WorkflowEngine.WorkflowEngine["Type"]
}): AgentToolHostService => ({
  spawnChildContext: ({
    parentContextId,
    toolUseId,
    agentKind,
    prompt,
    spawnOptions,
  }) =>
    Effect.gen(function* () {
      const childContextId = childContextIdForToolUse(parentContextId, toolUseId)
      const intent = normalizeRuntimeIntent(local.jsonl({
        argv: [agentKind],
        ...(spawnOptions?.cwd === undefined ? {} : { cwd: spawnOptions.cwd }),
      }))
      // firegrid-factory-aligned-agent-tools.SESSION.1
      // firegrid-factory-aligned-agent-tools.SESSION.6
      yield* insertLocalRuntimeContext(intent, {
        contextId: childContextId,
        createdBy: `agent-tool:${parentContextId}`,
      }).pipe(
        Effect.provideService(RuntimeControlPlaneTable, captured.controlPlane),
        Effect.provideService(CurrentHostSession, captured.hostSession),
      )
      const inputId = sessionNewInputIdForToolUse(childContextId, toolUseId)
      yield* appendRuntimeIngress({
        contextId: childContextId,
        inputId,
        kind: "message",
        authoredBy: "workflow",
        payload: Prompt.userMessage({
          content: [Prompt.textPart({ text: prompt })],
        }),
        idempotencyKey: inputId,
      }).pipe(
        Effect.provideService(RuntimeHostConfig, captured.hostConfig),
        Effect.provideService(RuntimeControlPlaneTable, captured.controlPlane),
      )
      yield* requireLocalContext(childContextId).pipe(
        Effect.provideService(RuntimeControlPlaneTable, captured.controlPlane),
        Effect.provideService(CurrentHostSession, captured.hostSession),
      )
      yield* executeRuntimeContextWorkflow(
        captured.workflowEngine,
        RuntimeContextWorkflow,
        {
          executionId: runtimeContextWorkflowExecutionId(childContextId),
          payload: RuntimeContextWorkflowPayload.make({
            contextId: childContextId,
          }),
          discard: true,
        },
      ).pipe(Effect.withClock(runtimeExecutionClock))
      return {
        childContextId,
        status: "running" as const,
      }
    }).pipe(
      Effect.mapError(cause => toolExecutionFailed(toolUseId, "session_new", cause)),
    ),
  spawnChildContexts: ({ toolUseId }) => unsupportedAgentTool(toolUseId, "spawn_all"),
  executeSandboxTool: ({ toolUseId }) => unsupportedAgentTool(toolUseId, "execute"),
  executeSessionCapability: ({ toolUseId }) =>
    unsupportedAgentTool(toolUseId, "execute"),
  appendSessionPrompt: ({ toolUseId, sessionId, inputId, prompt }) =>
    // firegrid-factory-aligned-agent-tools.PROMPT_DISPATCH.2
    appendRuntimeIngress({
      contextId: sessionId,
      inputId,
      kind: "message",
      authoredBy: "workflow",
      payload: prompt,
      idempotencyKey: inputId,
    }).pipe(
      Effect.provideService(RuntimeHostConfig, captured.hostConfig),
      Effect.provideService(RuntimeControlPlaneTable, captured.controlPlane),
      Effect.asVoid,
      Effect.mapError(cause =>
        toolExecutionFailed(toolUseId, "session_prompt", cause)),
    ),
  cancelSession: ({ toolUseId }) =>
    unsupportedAgentTool(toolUseId, "session_cancel"),
  closeSession: ({ toolUseId }) =>
    unsupportedAgentTool(toolUseId, "session_close"),
  appendScheduledPrompt: ({ contextId, inputId, prompt }) =>
    // firegrid-host-context-authority.PROMPT_ROUTING.3
    appendRuntimeIngress({
      contextId,
      inputId,
      kind: "message",
      authoredBy: "workflow",
      payload: prompt,
      idempotencyKey: inputId,
    }).pipe(
      Effect.provideService(RuntimeHostConfig, captured.hostConfig),
      Effect.provideService(RuntimeControlPlaneTable, captured.controlPlane),
      Effect.asVoid,
      Effect.mapError(cause =>
        toolExecutionFailed(inputId, "schedule_me", cause)),
    ),
})

export const RuntimeHostAgentToolHostLive = Layer.effect(
  AgentToolHost,
  Effect.gen(function* () {
    const hostConfig = yield* RuntimeHostConfig
    const controlPlane = yield* RuntimeControlPlaneTable
    const hostSession = yield* CurrentHostSession
    const workflowEngine = yield* WorkflowEngine.WorkflowEngine
    return runtimeHostAgentToolHostService({
      hostConfig,
      controlPlane,
      hostSession,
      workflowEngine,
    })
  }),
)
