import {
  Activity,
  DurableDeferred,
  Workflow,
  WorkflowEngine,
} from "@effect/workflow"
import {
  CurrentHostSession,
  RuntimeControlPlaneTable,
  local,
  makeHostSessionRow,
  makeHostStreamPrefix,
  normalizeRuntimeIntent,
  runtimeControlPlaneStreamUrl,
  runtimeContextWorkflowStreamUrl,
  type HostId,
  type HostSessionId,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import {
  durableStreamUrl,
  type FiregridHost,
} from "@firegrid/host-sdk"
import type {
  RuntimeIngressInputRow,
} from "@firegrid/protocol/runtime-ingress"
import { withRowOtelParent } from "@firegrid/protocol/otel"
/* eslint-disable @effect/no-import-from-barrel-package -- tiny-firegrid must use the public runtime surface, not runtime internals. */
import {
  RuntimeContextError,
  asRuntimeContextError,
} from "@firegrid/runtime"
/* eslint-enable @effect/no-import-from-barrel-package */
import {
  RuntimeAgentOutputAfterEvents,
  type RuntimeAgentOutputObservation,
} from "@firegrid/runtime/runtime-output"
import {
  AgentOutputEventSchema,
  type AgentInputEvent,
} from "@firegrid/runtime/events"
import {
  RuntimeControlPlaneRecorderLive,
} from "@firegrid/runtime/control-plane"
import {
  DurableStreamsWorkflowEngine,
  WorkflowEngineTable,
  type WorkflowExecutionRow,
} from "@firegrid/runtime/workflow-engine"
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  Schema,
  Stream,
  Cause,
} from "effect"
// nosemgrep: firegrid-runtime-no-host-internal-imports-outside-host -- simulation intentionally probes private runtime-context workflow composition before production promotion.
import { RuntimeHostConfig } from "../../../../host-sdk/src/host/config.ts"
// nosemgrep: firegrid-runtime-no-host-internal-imports-outside-host -- simulation intentionally probes private runtime-context workflow composition before production promotion.
import {
  executeRuntimeContextWorkflow,
} from "../../../../host-sdk/src/host/internal/run-context-workflow.ts"
// nosemgrep: firegrid-runtime-no-host-internal-imports-outside-host -- simulation intentionally probes private runtime-context workflow composition before production promotion.
import {
  RuntimeContextWorkflowPayload,
  StartRuntimeResultSchema,
  agentInputEventFromRuntimeIngressRow,
  allocateRuntimeActivityAttempt,
  failAfterWritingRunFailed,
  type RuntimeExitEvidence,
  type StartRuntimeResult,
  writeRunExitedResult,
  writeRunFailedResult,
  writeRunStarted,
} from "@firegrid/runtime/workflows"
// nosemgrep: firegrid-runtime-no-host-internal-imports-outside-host -- simulation intentionally probes private runtime-context workflow composition before production promotion.
import {
  readRuntimeContext,
  runtimeContextWorkflowExecutionId,
  runtimeExecutionClock,
} from "../../../../host-sdk/src/host/internal/runtime-context-helpers.ts"
import {
  PerContextRuntimeAgentOutputAfterEventsLive,
  PerContextRuntimeOutputWriter,
  PerContextRuntimeOutputWriterLive,
} from "../../../../host-sdk/src/host/per-context-runtime-output.ts"
import {
  appendRuntimeInputDeferred,
} from "../../../../host-sdk/src/host/runtime-input-deferred.ts"
import {
  RuntimeContextWorkflowSession,
  runtimeInputDeferredFor,
} from "../../../../host-sdk/src/host/runtime-context-workflow-core.ts"
import type { TinyFiregridHostEnv } from "../../types.ts"

const hostId = "host-a" as HostId
const contextId = "ctx_phase0_wave_2b_stream_zip_restart_replay"

const capabilities = {
  streamingText: false,
  tools: false,
  permissions: false,
  images: false,
  structuredInput: false,
  cancellation: false,
  multiTurn: true,
  customStatus: [],
} as const

const RuntimeContextSessionStartedEvidenceSchema = Schema.Struct({
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  ownerKind: Schema.Literal("raw", "codec"),
  ownerSessionId: Schema.String,
  startCommandId: Schema.String,
})

const RuntimeContextSessionStartOutcomeSchema = Schema.Union(
  Schema.TaggedStruct("Started", {
    evidence: RuntimeContextSessionStartedEvidenceSchema,
  }),
  Schema.TaggedStruct("Failed", {
    error: RuntimeContextError,
  }),
)

const RuntimeContextSessionCommandAcceptedSchema = Schema.Struct({
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  commandId: Schema.String,
  ownerSessionId: Schema.String,
})

const RuntimeAgentOutputObservationSchema = Schema.Struct({
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  sequence: Schema.Number,
  _tag: Schema.Literal(
    "Ready",
    "TextChunk",
    "ToolUse",
    "PermissionRequest",
    "TurnComplete",
    "Status",
    "Error",
    "Terminated",
  ),
  event: AgentOutputEventSchema,
  permissionRequestId: Schema.optional(Schema.String),
  toolUseId: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
}) as unknown as Schema.Schema<RuntimeAgentOutputObservation>

interface RuntimeContextSessionCommand {
  readonly _tag: "AgentInput"
  readonly commandId: string
  readonly event: AgentInputEvent
}

interface StreamZipState {
  readonly handledInputSequence: Ref.Ref<number>
  readonly handledOutputSequence: Ref.Ref<number>
  readonly exitEvidence: Ref.Ref<RuntimeExitEvidence>
}

interface PairRecord {
  readonly generation: 1 | 2
  readonly inputSequence: number
  readonly outputSequence: number
  readonly outputTag: string
}

interface EmissionRecord {
  readonly generation: 1 | 2
  readonly commandId: string
  readonly inputTag: string
}

interface GenerationEvents {
  readonly starts: Array<string>
  readonly emissions: Array<EmissionRecord>
  readonly pairs: Array<PairRecord>
}

type Phase0Wave2BDedupVerdict =
  | "GREEN-DEDUP-WORKS"
  | "HANDLER-NEEDS-SEQ-TRACKING"
  | "JOURNAL-NEEDS-CHECKPOINT"

interface Phase0Wave2BResult {
  readonly verdict: "GREEN"
  readonly dedupVerdict: Phase0Wave2BDedupVerdict
  readonly executionId: string
  readonly contextId: string
  readonly gen1Pairs: ReadonlyArray<PairRecord>
  readonly gen2Pairs: ReadonlyArray<PairRecord>
  readonly gen1Emissions: ReadonlyArray<EmissionRecord>
  readonly gen2Emissions: ReadonlyArray<EmissionRecord>
  readonly gen2ReplayedPairCount: number
  readonly gen2DuplicateSendSuppressed: boolean
  readonly executionRows: number
}

/* eslint-disable local/no-module-durable-cache -- simulation-local host/driver handshake; restart state under test lives in Durable Streams. */
let resolveResult: (result: Phase0Wave2BResult) => void
let rejectResult: (error: unknown) => void

export const phase0Wave2BResult = new Promise<Phase0Wave2BResult>(
  (resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  },
)
/* eslint-enable local/no-module-durable-cache */

class Wave2BProbe extends Context.Tag("@firegrid/tiny/phase0/Wave2BProbe")<
  Wave2BProbe,
  {
    readonly generation: 1 | 2
    readonly recordPair: (record: Omit<PairRecord, "generation">) => Effect.Effect<void>
  }
>() {}

const startSessionActivity = (
  context: RuntimeContext,
  activityAttempt: number,
) =>
  Activity.make({
    name: `firegrid.wave2b.runtime-context.session.start.${context.contextId}.${activityAttempt}`,
    success: RuntimeContextSessionStartOutcomeSchema,
    error: Schema.Never,
    execute: Effect.gen(function*() {
      const session = yield* RuntimeContextWorkflowSession
      const evidence = yield* session.startOrAttach(context, activityAttempt)
      return { _tag: "Started" as const, evidence }
    }).pipe(
      Effect.catchAll(error => Effect.succeed({ _tag: "Failed" as const, error })),
      Effect.withSpan("firegrid.wave2b.stream_zip.session.start", {
        kind: "internal",
        attributes: {
          "firegrid.context.id": context.contextId,
          "firegrid.runtime.activity_attempt": activityAttempt,
        },
      }),
    ),
  })

const sendSessionActivity = (
  context: RuntimeContext,
  activityAttempt: number,
  command: RuntimeContextSessionCommand,
  name: string,
) =>
  Activity.make({
    name,
    success: RuntimeContextSessionCommandAcceptedSchema,
    error: RuntimeContextError,
    execute: Effect.gen(function*() {
      const session = yield* RuntimeContextWorkflowSession
      return yield* session.send(context, activityAttempt, command)
    }).pipe(
      Effect.withSpan("firegrid.wave2b.stream_zip.session.send", {
        kind: "internal",
        attributes: {
          "firegrid.context.id": context.contextId,
          "firegrid.runtime.activity_attempt": activityAttempt,
          "firegrid.runtime.command_id": command.commandId,
        },
      }),
    ),
  })

const awaitRuntimeInput = (
  inputContextId: string,
  sequence: number,
) =>
  DurableDeferred.await(runtimeInputDeferredFor(inputContextId, sequence)).pipe(
    Effect.mapError(cause =>
      asRuntimeContextError(
        "wave2b-stream-zip.input.await",
        "failed awaiting runtime input deferred",
        inputContextId,
        cause,
      )),
    Effect.withSpan("firegrid.wave2b.stream_zip.input.await", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": inputContextId,
        "firegrid.input.sequence": sequence,
      },
    }),
  )

const runtimeInputStream = (
  inputContextId: string,
): Stream.Stream<
  RuntimeIngressInputRow,
  RuntimeContextError,
  WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> =>
  Stream.unfoldEffect(0, sequence =>
    awaitRuntimeInput(inputContextId, sequence).pipe(
      Effect.map(row => Option.some([row, sequence + 1] as const)),
    )).pipe(
      Stream.withSpan("firegrid.wave2b.stream_zip.inputs", {
        kind: "internal",
        attributes: {
          "firegrid.context.id": inputContextId,
        },
      }),
    )

const runtimeOutputStream = (
  outputContextId: string,
  activityAttempt: number,
): Stream.Stream<
  RuntimeAgentOutputObservation,
  RuntimeContextError,
  RuntimeAgentOutputAfterEvents | WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> =>
  Stream.unfoldEffect(-1, afterSequence =>
    Activity.make({
      name: `firegrid.wave2b.runtime-context.output.after.${outputContextId}.${activityAttempt}.${afterSequence}`,
      success: RuntimeAgentOutputObservationSchema,
      error: RuntimeContextError,
      execute: Effect.gen(function*() {
        const events = yield* RuntimeAgentOutputAfterEvents
        const source = {
          _tag: "AgentOutputAfter",
          contextId: outputContextId,
          activityAttempt,
          afterSequence,
        } as const
        const initial = yield* events.initial(source).pipe(
          Effect.mapError(cause =>
            asRuntimeContextError(
              "wave2b-stream-zip.output.initial",
              "failed checking initial runtime output observation",
              outputContextId,
              cause,
            )),
        )
        return yield* Option.match(initial, {
          onNone: () =>
            events.after(source).pipe(
              Stream.runHead,
              Effect.mapError(cause =>
                asRuntimeContextError(
                  "wave2b-stream-zip.output.after",
                  "failed waiting for runtime output observation",
                  outputContextId,
                  cause,
                )),
              Effect.flatMap(match =>
                Option.match(match, {
                  onNone: () =>
                    asRuntimeContextError(
                      "wave2b-stream-zip.output.after",
                      "runtime output stream ended before an observation was available",
                      outputContextId,
                    ),
                  onSome: observation => Effect.succeed(observation),
                })),
            ),
          onSome: observation => Effect.succeed(observation),
        }).pipe(
          Effect.withSpan("firegrid.wave2b.stream_zip.output.after", {
            kind: "internal",
            attributes: {
              "firegrid.context.id": outputContextId,
              "firegrid.runtime.activity_attempt": activityAttempt,
              "firegrid.runtime.output.after_sequence": afterSequence,
              "firegrid.wave2b.output.initial_hit": Option.isSome(initial),
            },
          }),
        )
      }),
    }).pipe(
      Effect.map(row => Option.some([row, row.sequence] as const)),
    )).pipe(
      Stream.withSpan("firegrid.wave2b.stream_zip.outputs", {
        kind: "internal",
        attributes: {
          "firegrid.context.id": outputContextId,
          "firegrid.runtime.activity_attempt": activityAttempt,
        },
      }),
    )

const decodeRuntimeInputEvent = (
  inputContextId: string,
  row: RuntimeIngressInputRow,
) =>
  agentInputEventFromRuntimeIngressRow(row).pipe(
    Effect.mapError(cause =>
      asRuntimeContextError(
        "wave2b-stream-zip.input.decode",
        "failed decoding runtime input row",
        inputContextId,
        cause,
      )),
    Effect.withSpan("firegrid.wave2b.stream_zip.input.decode", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": inputContextId,
        "firegrid.input.id": row.inputId,
      },
    }),
  )

const sendRuntimeInputEvent = (
  context: RuntimeContext,
  activityAttempt: number,
  row: RuntimeIngressInputRow,
  event: AgentInputEvent,
) =>
  sendSessionActivity(
    context,
    activityAttempt,
    {
      _tag: "AgentInput",
      commandId: `wave2b-input-${context.contextId}-${row.inputId}`,
      event,
    },
    `firegrid.wave2b.runtime-context.session.send.runtime-input.${row.inputId}`,
  )

const handleInputIfNew = (
  context: RuntimeContext,
  activityAttempt: number,
  state: StreamZipState,
  input: RuntimeIngressInputRow,
) =>
  Effect.gen(function*() {
    const sequence = input.sequence ?? -1
    if (sequence <= (yield* Ref.get(state.handledInputSequence))) return
    const inputEvent = yield* decodeRuntimeInputEvent(context.contextId, input)
    yield* sendRuntimeInputEvent(context, activityAttempt, input, inputEvent).pipe(
      withRowOtelParent(input),
    )
    yield* Ref.set(state.handledInputSequence, sequence)
    yield* Effect.annotateCurrentSpan({
      "firegrid.input.sequence": sequence,
      "firegrid.agent_input.event_tag": inputEvent._tag,
    })
  }).pipe(
    Effect.withSpan("firegrid.wave2b.stream_zip.input.handle", {
      kind: "consumer",
      attributes: {
        "firegrid.context.id": context.contextId,
        "firegrid.runtime.activity_attempt": activityAttempt,
      },
    }),
  )

const handleOutputIfNew = (
  context: RuntimeContext,
  activityAttempt: number,
  state: StreamZipState,
  output: RuntimeAgentOutputObservation,
) =>
  Effect.gen(function*() {
    if (output.sequence <= (yield* Ref.get(state.handledOutputSequence))) return
    yield* Ref.set(state.handledOutputSequence, output.sequence)
    yield* Effect.annotateCurrentSpan({
      "firegrid.agent_output.event_tag": output.event._tag,
      "firegrid.runtime.output.sequence": output.sequence,
    })
    if (output.event._tag === "Terminated") {
      yield* Ref.set(state.exitEvidence, { exitCode: output.event.exitCode ?? 0 })
    }
  }).pipe(
    Effect.withSpan("firegrid.wave2b.stream_zip.output.handle", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": context.contextId,
        "firegrid.runtime.activity_attempt": activityAttempt,
      },
    }),
  )

const handleZipPair = (
  context: RuntimeContext,
  activityAttempt: number,
  state: StreamZipState,
  pair: readonly [RuntimeIngressInputRow, RuntimeAgentOutputObservation],
) => {
  const [input, output] = pair
  return Effect.gen(function*() {
    const probe = yield* Wave2BProbe
    const inputSequence = input.sequence ?? -1
    yield* probe.recordPair({
      inputSequence,
      outputSequence: output.sequence,
      outputTag: output.event._tag,
    })
    yield* Effect.annotateCurrentSpan({
      "firegrid.context.id": context.contextId,
      "firegrid.input.sequence": inputSequence,
      "firegrid.runtime.output.sequence": output.sequence,
      "firegrid.agent_output.event_tag": output.event._tag,
      "firegrid.wave2b.generation": probe.generation,
    })
    yield* handleInputIfNew(context, activityAttempt, state, input)
    yield* handleOutputIfNew(context, activityAttempt, state, output)
  }).pipe(
    Effect.withSpan("firegrid.wave2b.stream_zip.pair", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": context.contextId,
        "firegrid.runtime.activity_attempt": activityAttempt,
      },
    }),
  )
}

const runZipLatestBody = (
  context: RuntimeContext,
  activityAttempt: number,
): Effect.Effect<RuntimeExitEvidence, RuntimeContextError, unknown> =>
  Effect.gen(function*() {
    const state: StreamZipState = {
      handledInputSequence: yield* Ref.make(-1),
      handledOutputSequence: yield* Ref.make(-1),
      exitEvidence: yield* Ref.make({ exitCode: 0 }),
    }
    yield* Stream.zipLatest(
      runtimeInputStream(context.contextId),
      runtimeOutputStream(context.contextId, activityAttempt),
    ).pipe(
      Stream.runForEach(pair => handleZipPair(context, activityAttempt, state, pair)),
    )
    return yield* Ref.get(state.exitEvidence)
  }).pipe(
    Effect.withSpan("firegrid.wave2b.stream_zip.body.run", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": context.contextId,
        "firegrid.runtime.activity_attempt": activityAttempt,
      },
    }),
  )

const runWorkflowStreamZipRuntimeContext = (
  inputContextId: string,
): Effect.Effect<StartRuntimeResult, RuntimeContextError, unknown> =>
  Effect.gen(function*() {
    const context = yield* readRuntimeContext(inputContextId)
    const activityAttempt = yield* allocateRuntimeActivityAttempt(context)
    yield* writeRunStarted(context, activityAttempt)
    const exit = yield* Effect.gen(function*() {
      const start = yield* startSessionActivity(context, activityAttempt)
      if (start._tag === "Failed") {
        return yield* writeRunFailedResult(context, activityAttempt, start.error)
      }
      return yield* runZipLatestBody(context, activityAttempt)
    }).pipe(
      Effect.catchAll(failAfterWritingRunFailed(context, activityAttempt)),
    )
    if ("failure" in exit && exit.failure !== undefined) return exit
    return yield* writeRunExitedResult(context, activityAttempt, exit)
  }).pipe(
    Effect.withSpan("firegrid.wave2b.stream_zip.workflow.run", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": inputContextId,
      },
    }),
    Effect.annotateSpans("firegrid.context.id", inputContextId),
  )

const RuntimeContextWorkflowStreamZip = Workflow.make({
  name: "firegrid.runtime-context",
  payload: RuntimeContextWorkflowPayload,
  success: StartRuntimeResultSchema,
  error: RuntimeContextError,
  idempotencyKey: ({ contextId }) => runtimeContextWorkflowExecutionId(contextId),
}).annotate(Workflow.SuspendOnFailure, true)

const RuntimeContextWorkflowStreamZipLayer = Layer.scopedDiscard(
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine
    const captured = yield* Effect.context<
      | RuntimeContextWorkflowSession
      | RuntimeAgentOutputAfterEvents
      | WorkflowEngine.WorkflowEngine
      | WorkflowEngineTable
      | RuntimeControlPlaneTable
      | Wave2BProbe
    >()
    yield* engine.register(RuntimeContextWorkflowStreamZip, ({ contextId }) =>
      runWorkflowStreamZipRuntimeContext(contextId).pipe(
        Effect.provide(captured),
      ))
  }).pipe(
    Effect.withSpan("firegrid.wave2b.stream_zip.workflow.register", {
      kind: "internal",
    }),
  ),
)

interface Streams {
  readonly workflow: string
  readonly control: string
  readonly hostOutput: string
}

const tableOptions = (streamUrl: string) => ({
  streamOptions: {
    url: streamUrl,
    contentType: "application/json",
  },
  txTimeoutMs: 2_000,
})

const hostSessionLayer = (
  namespace: string,
) =>
  Layer.succeed(
    CurrentHostSession,
    makeHostSessionRow({
      hostId,
      hostSessionId: `hs_${crypto.randomUUID()}` as HostSessionId,
      namespace,
      startedAtMs: 1_700_000_000_000,
    }),
  )

const hostConfigLayer = (
  env: TinyFiregridHostEnv,
) =>
  Layer.succeed(RuntimeHostConfig, {
    inputEnabled: true,
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
  })

const runtimeContext = (
  namespace: string,
): RuntimeContext => ({
  contextId,
  createdAt: "2026-05-20T00:00:00.000Z",
  runtime: normalizeRuntimeIntent(local.jsonl({
    argv: ["node", "-e", "process.exit(0)"],
    agentProtocol: "stdio-jsonl",
  })),
  host: {
    hostId,
    streamPrefix: makeHostStreamPrefix({ namespace, hostId }),
    boundAtMs: 1_700_000_000_000,
  },
})

const sessionLayer = (
  generation: 1 | 2,
  events: GenerationEvents,
) =>
  RuntimeContextWorkflowSession.layer({
    startOrAttach: (context, activityAttempt) =>
      Effect.sync(() => {
        const key = `${context.contextId}:${activityAttempt}`
        if (!events.starts.includes(key)) events.starts.push(key)
        return {
          contextId: context.contextId,
          activityAttempt,
          ownerKind: "codec" as const,
          ownerSessionId: `owner-${context.contextId}-${activityAttempt}`,
          startCommandId: `start-${context.contextId}-${activityAttempt}`,
        }
      }),
    send: (context, activityAttempt, command) =>
      Effect.sync(() => {
        events.emissions.push({
          generation,
          commandId: command.commandId,
          inputTag: command.event._tag,
        })
        return {
          contextId: context.contextId,
          activityAttempt,
          commandId: command.commandId,
          ownerSessionId: `owner-${context.contextId}-${activityAttempt}`,
        }
      }),
  })

const probeLayer = (
  generation: 1 | 2,
  events: GenerationEvents,
) =>
  Layer.succeed(Wave2BProbe, {
    generation,
    recordPair: record =>
      Effect.sync(() => {
        events.pairs.push({ generation, ...record })
      }),
  })

const generationLayer = (
  env: TinyFiregridHostEnv,
  streams: Streams,
  generation: 1 | 2,
  events: GenerationEvents,
) =>
  RuntimeContextWorkflowStreamZipLayer.pipe(
    Layer.provideMerge(sessionLayer(generation, events)),
    Layer.provideMerge(probeLayer(generation, events)),
    Layer.provideMerge(PerContextRuntimeAgentOutputAfterEventsLive),
    Layer.provideMerge(PerContextRuntimeOutputWriterLive),
    Layer.provideMerge(RuntimeControlPlaneRecorderLive),
    Layer.provideMerge(DurableStreamsWorkflowEngine.layer({
      streamUrl: streams.workflow,
      workerId: `wave2b-generation-${generation}`,
    })),
    Layer.provideMerge(RuntimeControlPlaneTable.layer(tableOptions(streams.control))),
    Layer.provideMerge(hostSessionLayer(env.namespace)),
    Layer.provideMerge(hostConfigLayer(env)),
  ) as Layer.Layer<
    | RuntimeContextWorkflowSession
    | Wave2BProbe
    | RuntimeAgentOutputAfterEvents
    | PerContextRuntimeOutputWriter
    | RuntimeControlPlaneTable
    | WorkflowEngine.WorkflowEngine
    | WorkflowEngineTable,
    unknown
  >

const workflowTableLayer = (
  streams: Streams,
) =>
  WorkflowEngineTable.layer(tableOptions(streams.workflow))

const inspectExecutions = (
  streams: Streams,
): Effect.Effect<ReadonlyArray<WorkflowExecutionRow>, unknown> =>
  Effect.scoped(
    Effect.gen(function*() {
      const table = yield* WorkflowEngineTable
      return yield* table.executions.query(coll => coll.toArray)
    }).pipe(Effect.provide(workflowTableLayer(streams))),
  )

const waitUntil = <A>(
  label: string,
  poll: Effect.Effect<A, unknown>,
  satisfied: (value: A) => boolean,
): Effect.Effect<A, unknown> =>
  /* eslint-disable local/no-fixed-polling -- bounded probe polling waits for durable workflow replay visibility. */
  Effect.gen(function*() {
    const deadlineMs = (yield* Clock.currentTimeMillis) + 5_000
    let latest = yield* poll
    while (!satisfied(latest)) {
      if ((yield* Clock.currentTimeMillis) >= deadlineMs) {
        return yield* Effect.fail(new Error(`timed out waiting for ${label}`))
      }
      yield* Effect.sleep(Duration.millis(25))
      latest = yield* poll
    }
    return latest
  })
/* eslint-enable local/no-fixed-polling */

const waitForPair = (
  events: GenerationEvents,
  generation: 1 | 2,
  inputSequence: number,
  outputSequence: number,
) =>
  waitUntil(
    `generation ${generation} pair input=${inputSequence} output=${outputSequence}`,
    Effect.sync(() => events.pairs),
    pairs => pairs.some(pair =>
      pair.generation === generation &&
      pair.inputSequence === inputSequence &&
      pair.outputSequence === outputSequence),
  )

const waitForEmission = (
  events: GenerationEvents,
  generation: 1 | 2,
  commandId: string,
) =>
  waitUntil(
    `generation ${generation} emission ${commandId}`,
    Effect.sync(() => events.emissions),
    emissions => emissions.some(emission =>
      emission.generation === generation &&
      emission.commandId === commandId),
  )

const appendInput = (
  context: RuntimeContext,
  inputId: string,
  payload: string,
) =>
  appendRuntimeInputDeferred({
    contextId: context.contextId,
    inputId,
    kind: "message",
    authoredBy: "client",
    payload,
    idempotencyKey: inputId,
  }, context)

const appendOutput = (
  context: RuntimeContext,
  sequence: number,
  event: Parameters<PerContextRuntimeOutputWriter["Type"]["appendAgentEvent"]>[3],
) =>
  Effect.gen(function*() {
    const writer = yield* PerContextRuntimeOutputWriter
    yield* writer.appendAgentEvent(context, 1, sequence, event)
  })

const executeStreamZipRuntimeContext = (
  inputContextId: string,
) =>
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine
    return yield* executeRuntimeContextWorkflow(
      engine,
      RuntimeContextWorkflowStreamZip,
      {
        executionId: runtimeContextWorkflowExecutionId(inputContextId),
        payload: RuntimeContextWorkflowPayload.make({ contextId: inputContextId }),
        discard: true,
      },
    )
  })

const withGeneration = <A, E>(
  env: TinyFiregridHostEnv,
  streams: Streams,
  generation: 1 | 2,
  events: GenerationEvents,
  effect: Effect.Effect<A, E, unknown>,
): Effect.Effect<A, unknown, never> =>
  (Effect.scoped(
    effect.pipe(Effect.provide(generationLayer(env, streams, generation, events))),
  ).pipe(
    Effect.withClock(runtimeExecutionClock),
    Effect.withSpan("firegrid.wave2b.host_generation", {
      kind: "internal",
      attributes: {
        "firegrid.wave2b.generation": generation,
      },
    }),
  ) as Effect.Effect<A, unknown, never>)

const assertCondition = (
  label: string,
  condition: boolean,
) =>
  condition ? Effect.void : Effect.fail(new Error(label))

const runProbe = (
  env: TinyFiregridHostEnv,
): Effect.Effect<Phase0Wave2BResult, unknown> => {
  const context = runtimeContext(env.namespace)
  const streamPrefix = `${env.namespace}.${env.runId}.wave2b`
  const streams: Streams = {
    workflow: runtimeContextWorkflowStreamUrl({
      baseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
      contextId: context.contextId,
    }),
    control: runtimeControlPlaneStreamUrl({
      baseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
    }),
    hostOutput: durableStreamUrl(env.durableStreamsBaseUrl, `${streamPrefix}.host-output`),
  }
  const events: GenerationEvents = {
    starts: [],
    emissions: [],
    pairs: [],
  }
  const executionId = runtimeContextWorkflowExecutionId(context.contextId)
  const gen1CommandId = `wave2b-input-${context.contextId}-wave2b-input-0`
  const gen2CommandId = `wave2b-input-${context.contextId}-wave2b-input-1`

  return Effect.gen(function*() {
    yield* withGeneration(
      env,
      streams,
      1,
      events,
      Effect.gen(function*() {
        const control = yield* RuntimeControlPlaneTable
        yield* control.contexts.upsert(context)
        const startedExecutionId = yield* executeStreamZipRuntimeContext(context.contextId)
        yield* assertCondition(
          "generation 1 execution id mismatch",
          startedExecutionId === executionId,
        )
        yield* appendInput(context, "wave2b-input-0", "generation 1 input")
        yield* appendOutput(context, 0, {
          _tag: "Ready",
          capabilities,
        })
        yield* waitForPair(events, 1, 0, 0)
        yield* waitForEmission(events, 1, gen1CommandId)
      }),
    )

    yield* withGeneration(
      env,
      streams,
      2,
      events,
      Effect.gen(function*() {
        const resumedExecutionId = yield* executeStreamZipRuntimeContext(context.contextId)
        yield* assertCondition(
          "generation 2 execution id mismatch",
          resumedExecutionId === executionId,
        )
        yield* appendInput(context, "wave2b-input-1", "generation 2 input")
        yield* appendOutput(context, 1, {
          _tag: "Status",
          kind: "wave2b-after-restart",
          payload: { generation: 2 },
        })
        yield* waitForPair(events, 2, 1, 1)
        yield* waitForEmission(events, 2, gen2CommandId)
      }),
    )

    const executions = yield* inspectExecutions(streams)
    const gen1Pairs = events.pairs.filter(pair => pair.generation === 1)
    const gen2Pairs = events.pairs.filter(pair => pair.generation === 2)
    const gen1Emissions = events.emissions.filter(emission => emission.generation === 1)
    const gen2Emissions = events.emissions.filter(emission => emission.generation === 2)
    const gen2ReplayedPairCount = gen2Pairs.filter(pair =>
      pair.inputSequence === 0 && pair.outputSequence === 0,
    ).length
    const gen2DuplicateSendSuppressed = !gen2Emissions.some(
      emission => emission.commandId === gen1CommandId,
    )
    const dedupVerdict: Phase0Wave2BDedupVerdict = gen2ReplayedPairCount === 0
      ? "GREEN-DEDUP-WORKS"
      : "HANDLER-NEEDS-SEQ-TRACKING"
    yield* assertCondition(
      "generation 2 replay duplicated generation 1 send activity",
      gen2DuplicateSendSuppressed,
    )
    yield* Effect.annotateCurrentSpan({
      "firegrid.wave2b.verdict": "GREEN",
      "firegrid.wave2b.dedup_verdict": dedupVerdict,
      "firegrid.wave2b.execution_id": executionId,
      "firegrid.wave2b.gen1_pair_count": gen1Pairs.length,
      "firegrid.wave2b.gen2_pair_count": gen2Pairs.length,
      "firegrid.wave2b.gen2_replayed_pair_count": gen2ReplayedPairCount,
      "firegrid.wave2b.gen1_emission_count": gen1Emissions.length,
      "firegrid.wave2b.gen2_emission_count": gen2Emissions.length,
      "firegrid.wave2b.gen2_duplicate_send_suppressed": gen2DuplicateSendSuppressed,
      "firegrid.wave2b.execution_rows": executions.length,
    })
    return {
      verdict: "GREEN" as const,
      dedupVerdict,
      executionId,
      contextId: context.contextId,
      gen1Pairs,
      gen2Pairs,
      gen1Emissions,
      gen2Emissions,
      gen2ReplayedPairCount,
      gen2DuplicateSendSuppressed,
      executionRows: executions.length,
    }
  }).pipe(
    Effect.withSpan("firegrid.wave2b.restart_replay.probe", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": context.contextId,
        "firegrid.wave2b.workflow_stream": streams.workflow,
        "firegrid.wave2b.control_stream": streams.control,
        "firegrid.wave2b.host_output_stream": streams.hostOutput,
      },
    }),
  )
}

const publishResult = (
  env: TinyFiregridHostEnv,
): Effect.Effect<void, unknown> =>
  runProbe(env).pipe(
    Effect.matchCauseEffect({
      onFailure: cause =>
        Effect.sync(() => {
          rejectResult(new Error(Cause.pretty(cause)))
        }).pipe(Effect.zipRight(Effect.failCause(cause))),
      onSuccess: result =>
        Effect.sync(() => {
          resolveResult(result)
        }),
    }),
  )

export const phase0Wave2BHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown> =>
  Layer.scopedDiscard(
    publishResult(env).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          rejectResult(new Error("phase0 wave-2b host interrupted"))
        })),
      Effect.withSpan("firegrid.wave2b.host"),
    ),
  ) as Layer.Layer<FiregridHost, unknown>
