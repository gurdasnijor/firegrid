import { Prompt, Response } from "@effect/ai"
import { FetchHttpClient } from "@effect/platform"
import { DurableDeferred, Workflow, WorkflowEngine } from "@effect/workflow"
import {
  CurrentHostSession,
  makeHostSessionRow,
  makeHostStreamPrefix,
  RuntimeControlPlaneTable,
  runtimeContextOutputStreamUrl,
  runtimeContextWorkflowStreamUrl,
  RuntimeOutputTable,
  runtimeControlPlaneStreamUrl,
  type HostId,
  type RuntimeControlPlaneTableService,
  type RuntimeEventRow,
  type RuntimeOutputTableService,
} from "@firegrid/protocol/launch"
import {
  makeRuntimeInputIntentRow,
  RuntimeInputIntentRowSchema,
  type RuntimeInputIntentRow,
} from "@firegrid/protocol/runtime-ingress"
import { AgentCodecError, type AgentSessionService } from "@firegrid/runtime/codecs"
import {
  encodeRuntimeAgentOutputEnvelope,
  runtimeAgentOutputObservationFromRow,
  type AgentInputEvent,
  type AgentOutputEvent,
  type RuntimeAgentOutputObservation,
} from "@firegrid/runtime/events"
import { DurableStreamsWorkflowEngine } from "@firegrid/runtime/workflow-engine"
import type { WorkflowEngineTable } from "@firegrid/runtime/workflow-engine"
import type { ProcessOutputChunk } from "@firegrid/runtime/sources/sandbox"
import { Chunk, Context, Duration, Effect, Exit, Fiber, Layer, Option, Ref, Schema, Stream } from "effect"
import type { Scope } from "effect"
import type { DurableTableError } from "effect-durable-operators"
import { codecBoundaryFromSession } from "../runtime/agent-event-pipeline/codecs/contract.ts"
import { tinySandbox, tinySandboxProvider } from "../runtime/agent-event-pipeline/sources/sandbox/SandboxProvider.ts"

interface DurableStreamsBackedPipelineOptions {
  readonly baseUrl: string
  readonly namespace?: string
  readonly contextId?: string
  readonly hostId?: string
}

interface DurableStreamsBackedPipelineConfig {
  readonly baseUrl: string
  readonly namespace: string
  readonly contextId: string
  readonly hostId: HostId
  readonly hostSession: CurrentHostSession["Type"]
  readonly controlPlaneStreamUrl: string
  readonly outputStreamUrl: string
  readonly workflowStreamUrl: string
}

interface DispatcherDrivenResult {
  readonly executionId: string
  readonly intent: RuntimeInputIntentRow
  readonly observations: ReadonlyArray<RuntimeAgentOutputObservation>
  readonly workflowOutput: {
    readonly sentInputs: number
    readonly persistedOutputs: number
  }
}

interface ReplayFirstRunResult {
  readonly completed: DispatcherDrivenResult
  readonly partial: ReadonlyArray<RuntimeAgentOutputObservation>
}

interface ReplaySecondRunResult {
  readonly observations: ReadonlyArray<RuntimeAgentOutputObservation>
  readonly workflowOutput: DispatcherDrivenResult["workflowOutput"]
}

interface DurableStreamsBackedRunResult extends DispatcherDrivenResult {
  readonly outputStreamUrl: string
  readonly sentInputs: ReadonlyArray<AgentInputEvent>
  readonly workflowStreamUrl: string
}

interface DurableStreamsBackedReplayResult {
  readonly firstRun: ReplayFirstRunResult
  readonly firstRunSentInputs: ReadonlyArray<AgentInputEvent>
  readonly secondRun: ReplaySecondRunResult
  readonly secondRunSentInputs: ReadonlyArray<AgentInputEvent>
}

interface TinyDurableStreamsBackedPipeline {
  readonly runEndToEnd: () => Effect.Effect<
    DurableStreamsBackedRunResult,
    string | DurableTableError,
    never
  >
  readonly replayCompletedWorkflow: () => Effect.Effect<
    DurableStreamsBackedReplayResult,
    string | DurableTableError,
    never
  >
}

const TinyDurableRuntimeInputDeferred = DurableDeferred.make(
  "tiny-firegrid.durable.runtime-input.0",
  { success: RuntimeInputIntentRowSchema },
)

const TinyDurableRuntimeWorkflow = Workflow.make({
  name: "tiny-firegrid.durable.runtime-context",
  payload: {
    contextId: Schema.String,
  },
  success: Schema.Struct({
    sentInputs: Schema.Number,
    persistedOutputs: Schema.Number,
  }),
  error: Schema.String,
  idempotencyKey: ({ contextId }) => contextId,
})

const defaultConfig = (
  options: DurableStreamsBackedPipelineOptions,
): DurableStreamsBackedPipelineConfig => {
  const namespace = options.namespace ?? `tiny-${crypto.randomUUID()}`
  const contextId = options.contextId ?? "ctx-a"
  const hostId = (options.hostId ?? "host-a") as HostId
  const hostSessionId = `${hostId}-session` as CurrentHostSession["Type"]["hostSessionId"]
  const streamPrefix = makeHostStreamPrefix({ namespace, hostId })
  return {
    baseUrl: options.baseUrl,
    namespace,
    contextId,
    hostId,
    hostSession: makeHostSessionRow({
      hostId,
      hostSessionId,
      namespace,
      startedAtMs: 0,
    }),
    controlPlaneStreamUrl: runtimeControlPlaneStreamUrl({
      baseUrl: options.baseUrl,
      namespace,
    }),
    outputStreamUrl: runtimeContextOutputStreamUrl({
      baseUrl: options.baseUrl,
      prefix: streamPrefix,
      contextId,
    }),
    workflowStreamUrl: runtimeContextWorkflowStreamUrl({
      baseUrl: options.baseUrl,
      namespace,
      contextId,
    }),
  }
}

const textFromIntentPayload = (payload: unknown): string => {
  if (typeof payload === "string") return payload
  if (typeof payload === "object" && payload !== null) {
    const record = payload as Record<string, unknown>
    if (record.type === "text" && typeof record.text === "string") return record.text
  }
  return JSON.stringify(payload)
}

const agentInputEventFromIntent = (
  intent: RuntimeInputIntentRow,
): AgentInputEvent => ({
  _tag: "Prompt",
  correlationId: intent.intentId,
  prompt: Prompt.userMessage({
    content: [Prompt.textPart({ text: textFromIntentPayload(intent.payload) })],
  }),
})

const agentOutputEventFromChunk = (
  chunk: Extract<ProcessOutputChunk, { readonly type: "output" }>,
): AgentOutputEvent => ({
  _tag: "TextChunk",
  part: Response.textDeltaPart({
    id: "tiny-firegrid",
    delta: chunk.text,
  }),
})

const makeTinyAgentSession = (
  input: {
    readonly chunks: Stream.Stream<ProcessOutputChunk, unknown>
    readonly sentInputs: Array<AgentInputEvent>
  },
): AgentSessionService => ({
  meta: {
    kind: "tiny-firegrid",
    capabilities: {
      streamingText: true,
      tools: false,
      permissions: false,
      images: false,
      structuredInput: false,
      cancellation: false,
      multiTurn: true,
      customStatus: [],
    },
  },
  toolUseMode: "observation_only",
  send: event =>
    Effect.sync(() => {
      input.sentInputs.push(event)
    }),
  outputs: input.chunks.pipe(
    Stream.mapError(cause => new AgentCodecError({
      codec: "tiny-firegrid",
      op: "sandbox.stream",
      message: String(cause),
      cause,
    })),
    Stream.filter((chunk): chunk is Extract<ProcessOutputChunk, { readonly type: "output" }> =>
      chunk.type === "output" && chunk.channel === "stdout"),
    Stream.map(agentOutputEventFromChunk),
  ),
})

const makeTinyAgentSessionFromChunks = (
  input: {
    readonly chunks: ReadonlyArray<ProcessOutputChunk>
    readonly sentInputs: Array<AgentInputEvent>
  },
): AgentSessionService => {
  const sandboxProvider = tinySandboxProvider(input.chunks)
  return makeTinyAgentSession({
    chunks: sandboxProvider.stream(tinySandbox(), { argv: ["tiny-agent"] }),
    sentInputs: input.sentInputs,
  })
}

const eventRowFromAgentOutput = (
  input: {
    readonly contextId: string
    readonly activityAttempt: number
    readonly sequence: number
    readonly event: AgentOutputEvent
  },
): RuntimeEventRow => ({
  eventId: {
    contextId: input.contextId,
    activityAttempt: input.activityAttempt,
    target: "events",
    sequence: input.sequence,
  },
  contextId: input.contextId,
  activityAttempt: input.activityAttempt,
  sequence: input.sequence,
  source: "stdout",
  format: "jsonl",
  receivedAt: new Date(0).toISOString(),
  raw: encodeRuntimeAgentOutputEnvelope(input.event),
})

const persistAgentOutput = (
  row: RuntimeEventRow,
) =>
  Effect.gen(function*() {
    const output: RuntimeOutputTableService = yield* RuntimeOutputTable
    yield* output.events.upsert(row)
    return row
  })

const makeDurableRuntimeWorkflowLayer = (
  session: AgentSessionService,
) =>
  TinyDurableRuntimeWorkflow.toLayer(({ contextId }) =>
    Effect.gen(function*() {
      const intent = yield* DurableDeferred.await(TinyDurableRuntimeInputDeferred)
      const codec = codecBoundaryFromSession(session)
      yield* codec.send(agentInputEventFromIntent(intent))

      const persisted = yield* codec.outputs.pipe(
        Stream.mapAccum(0, (sequence, event) => [sequence + 1, { event, sequence }] as const),
        Stream.mapEffect(({ event, sequence }) =>
          persistAgentOutput(eventRowFromAgentOutput({
            contextId,
            activityAttempt: 0,
            sequence,
            event,
          })).pipe(Effect.as(event))),
        Stream.runCollect,
      )

      return {
        sentInputs: 1,
        persistedOutputs: Chunk.size(persisted),
      }
    }).pipe(Effect.mapError(cause => String(cause))))

const makeActiveEngineRegistry = Effect.gen(function*() {
  const engines = yield* Ref.make(new Map<string, {
    readonly contextId: string
    readonly deferred: typeof TinyDurableRuntimeInputDeferred
    readonly executionId: string
  }>())

  return {
    claimActive: (contextId: string) =>
      Effect.gen(function*() {
        const executionId = yield* TinyDurableRuntimeWorkflow.executionId({ contextId })
        const handle = {
          contextId,
          deferred: TinyDurableRuntimeInputDeferred,
          executionId,
        }
        yield* Ref.update(engines, current => new Map([...current, [contextId, handle]]))
        return handle
      }),
    get: (contextId: string) =>
      Ref.get(engines).pipe(
        Effect.map(current => Option.fromNullable(current.get(contextId))),
      ),
  }
})

const durableRuntimeLayer = (
  config: DurableStreamsBackedPipelineConfig,
  session: AgentSessionService,
): Layer.Layer<
  | RuntimeControlPlaneTable
  | RuntimeOutputTable
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngineTable
  | CurrentHostSession,
  DurableTableError,
  never
> => {
  const controlPlaneLayer = RuntimeControlPlaneTable.layer({
    streamOptions: {
      url: config.controlPlaneStreamUrl,
      contentType: "application/json",
    },
  })
  const outputLayer = RuntimeOutputTable.layer({
    streamOptions: {
      url: config.outputStreamUrl,
      contentType: "application/json",
    },
  })
  const engineLayer = DurableStreamsWorkflowEngine.layer({
    streamUrl: config.workflowStreamUrl,
    workerId: `${config.hostId}-worker`,
  })
  // Finding: DurableTable.layer/DurableStreamsWorkflowEngine.layer composition
  // exposes `any` through Effect's Layer pipe type here, even though each public
  // service consumed by the configuration is named below.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const servicesLayer: Layer.Layer<
    | RuntimeControlPlaneTable
    | RuntimeOutputTable
    | WorkflowEngine.WorkflowEngine
    | WorkflowEngineTable
    | CurrentHostSession,
    DurableTableError,
    never
  > = controlPlaneLayer.pipe(
    Layer.merge(outputLayer),
    Layer.merge(Layer.succeed(CurrentHostSession, config.hostSession)),
    Layer.provideMerge(engineLayer),
    Layer.provide(FetchHttpClient.layer),
  )

  // Finding: upstream Workflow.toLayer currently returns `any` for the layer
  // input channel. The surrounding production services layer is fully typed;
  // this narrow coercion keeps the finding local instead of weakening exported
  // tiny-firegrid configuration effects.
  const layer = servicesLayer.pipe(
    Layer.merge(makeDurableRuntimeWorkflowLayer(session).pipe(Layer.provide(servicesLayer))),
  )
  return layer as Layer.Layer<
    | RuntimeControlPlaneTable
    | RuntimeOutputTable
    | WorkflowEngine.WorkflowEngine
    | WorkflowEngineTable
    | CurrentHostSession,
    DurableTableError,
    never
  >
}

const makeIntent = (
  contextId: string,
): RuntimeInputIntentRow =>
  makeRuntimeInputIntentRow({
    inputId: "intent-a",
    contextId,
    kind: "message",
    authoredBy: "client",
    payload: { type: "text", text: "hello" },
  }, { createdAt: "1970-01-01T00:00:00.000Z" })

const readOutputObservations: Effect.Effect<
  ReadonlyArray<RuntimeAgentOutputObservation>,
  DurableTableError,
  RuntimeOutputTable
> = Effect.contextWithEffect((context: Context.Context<RuntimeOutputTable>) => {
  const output: RuntimeOutputTableService = Context.get(context, RuntimeOutputTable)
  return output.events.query(coll =>
    coll.toArray.flatMap(row =>
      Option.match(runtimeAgentOutputObservationFromRow(row), {
        onNone: () => [],
        onSome: observation => [observation],
      })),
  )
})

const runDispatcherDriven = (
  config: DurableStreamsBackedPipelineConfig,
): Effect.Effect<
  DispatcherDrivenResult,
  string | DurableTableError,
  RuntimeControlPlaneTable | RuntimeOutputTable | WorkflowEngine.WorkflowEngine | Scope.Scope
> =>
  Effect.contextWithEffect((
    context: Context.Context<RuntimeControlPlaneTable | RuntimeOutputTable | WorkflowEngine.WorkflowEngine | Scope.Scope>,
  ) => {
    const control: RuntimeControlPlaneTableService = Context.get(context, RuntimeControlPlaneTable)
    const engine: WorkflowEngine.WorkflowEngine["Type"] = Context.get(context, WorkflowEngine.WorkflowEngine)
    return Effect.gen(function*() {
    const registry = yield* makeActiveEngineRegistry
    const intent = makeIntent(config.contextId)
    const active = yield* registry.claimActive(intent.contextId)

    const dispatcher = control.inputIntents.rows().pipe(
      Stream.runForEach(observedIntent =>
        registry.get(observedIntent.contextId).pipe(
          Effect.flatMap(Option.match({
            onNone: () => Effect.void,
            onSome: handle =>
              engine.deferredDone(handle.deferred, {
                workflowName: TinyDurableRuntimeWorkflow.name,
                executionId: handle.executionId,
                deferredName: handle.deferred.name,
                exit: Exit.succeed(observedIntent),
              }),
          })),
        )),
      Effect.forkScoped,
    )

    yield* dispatcher
    yield* control.inputIntents.insertOrGet(intent)

    const workflowOutput = yield* TinyDurableRuntimeWorkflow.execute({
      contextId: intent.contextId,
    })
    const observations = yield* readOutputObservations

    return {
      executionId: active.executionId,
      intent,
      observations,
      workflowOutput,
    }
  })
  })

const waitForObservationCount = (
  count: number,
): Effect.Effect<ReadonlyArray<RuntimeAgentOutputObservation>, DurableTableError, RuntimeOutputTable> =>
  Effect.contextWithEffect((context: Context.Context<RuntimeOutputTable>) => {
    const output: RuntimeOutputTableService = Context.get(context, RuntimeOutputTable)
    const rows: Stream.Stream<RuntimeEventRow, DurableTableError> = output.events.rows()
    const collect: Effect.Effect<
      ReadonlyArray<RuntimeAgentOutputObservation>,
      DurableTableError
    > = rows.pipe(
      Stream.filterMap(runtimeAgentOutputObservationFromRow),
      Stream.take(count),
      Stream.runCollect,
      Effect.map(Chunk.toReadonlyArray),
    )
    return collect
  })

export const tinyDurableStreamsBackedPipeline = (
  options: DurableStreamsBackedPipelineOptions,
): TinyDurableStreamsBackedPipeline => {
  const config = defaultConfig(options)
  return {
    runEndToEnd: () =>
      Effect.gen(function*() {
        const sentInputs: Array<AgentInputEvent> = []
        const session = makeTinyAgentSessionFromChunks({
          chunks: [
            { type: "output", channel: "stdout", text: "hello" },
            { type: "exit", exitCode: 0 },
          ],
          sentInputs,
        })

        const result = yield* Effect.scoped(
          Effect.provide(runDispatcherDriven(config), durableRuntimeLayer(config, session)),
        )

        return {
          ...result,
          outputStreamUrl: config.outputStreamUrl,
          sentInputs: [...sentInputs],
          workflowStreamUrl: config.workflowStreamUrl,
        }
      }),

    replayCompletedWorkflow: () =>
      Effect.gen(function*() {
        const firstRunSentInputs: Array<AgentInputEvent> = []
        const secondRunSentInputs: Array<AgentInputEvent> = []
        const firstSession = makeTinyAgentSession({
          chunks: Stream.fromIterable([
            { type: "output", channel: "stdout", text: "first" } as const,
          ]).pipe(
            Stream.concat(
              Stream.fromEffect(
                Effect.sleep(Duration.millis(25)).pipe(
                  Effect.as({ type: "output", channel: "stdout", text: "second" } as const),
                ),
              ),
            ),
          ),
          sentInputs: firstRunSentInputs,
        })

        const firstRunProgram: Effect.Effect<
          ReplayFirstRunResult,
          string | DurableTableError,
          RuntimeControlPlaneTable | RuntimeOutputTable | WorkflowEngine.WorkflowEngine | Scope.Scope
        > =
          Effect.gen(function*() {
            const fiber = yield* runDispatcherDriven(config).pipe(Effect.fork)
            const partial = yield* waitForObservationCount(1)
            const completed = yield* Fiber.join(fiber)
            return { completed, partial }
          })
        const firstRun = yield* Effect.scoped(
          Effect.provide(firstRunProgram, durableRuntimeLayer(config, firstSession)),
        )

        const secondSession = makeTinyAgentSessionFromChunks({
          chunks: [
            { type: "output", channel: "stdout", text: "duplicate-if-replayed" },
            { type: "exit", exitCode: 0 },
          ],
          sentInputs: secondRunSentInputs,
        })
        const secondRunProgram: Effect.Effect<
          ReplaySecondRunResult,
          string | DurableTableError,
          RuntimeOutputTable | WorkflowEngine.WorkflowEngine
        > =
          Effect.gen(function*() {
            const workflowOutput = yield* TinyDurableRuntimeWorkflow.execute({
              contextId: config.contextId,
            })
            const observations = yield* readOutputObservations
            return { observations, workflowOutput }
          })
        const secondRun = yield* Effect.scoped(
          Effect.provide(secondRunProgram, durableRuntimeLayer(config, secondSession)),
        )

        return {
          firstRun,
          firstRunSentInputs: [...firstRunSentInputs],
          secondRun,
          secondRunSentInputs: [...secondRunSentInputs],
        }
      }),
  }
}
