import {
  Activity,
  DurableDeferred,
  Workflow,
  WorkflowEngine,
} from "@effect/workflow"
import {
  CurrentHostSession,
  RuntimeControlPlaneTable,
  makeLocalRuntimeContextForHostSession,
  normalizeRuntimeIntent,
  requireLocalContext,
} from "@firegrid/protocol/launch"
import type {
  RuntimeIngressInputRow,
} from "@firegrid/protocol/runtime-ingress"
import { withRowOtelParent } from "@firegrid/protocol/otel"
import {
  ensurePathInput,
  FiregridEnvBindingsFromEnv,
  FiregridLocalHostLive,
  FiregridLocalProcessFromEnv,
  FiregridMcpServerLayer,
  type FiregridHost,
} from "@firegrid/host-sdk"
/* eslint-disable @effect/no-import-from-barrel-package -- depcruise forbids the internal runtime errors subpath outside runtime/host-sdk; the root runtime export is the public surface for this sim. */
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
  AgentInputEventSchema,
  AgentOutputEventSchema,
  type AgentInputEvent,
  type AgentOutputEvent,
} from "@firegrid/runtime/events"
import {
  RuntimeToolUseExecutor,
} from "@firegrid/runtime/tool-executor"
import type {
  WorkflowEngineTable,
} from "@firegrid/runtime/workflow-engine"
import {
  Cause,
  Clock,
  Effect,
  Layer,
  Option,
  Ref,
  Schema,
  Stream,
} from "effect"
import {
  AgentToolHost,
  type AgentToolHostService,
} from "../../../../host-sdk/src/agent-tools/execution/tool-host.ts"
import {
  toolErrorResult,
  toolExecutionFailed,
} from "../../../../host-sdk/src/agent-tools/bindings/tool-error.ts"
import {
  executeRuntimeContextWorkflow,
} from "../../../../host-sdk/src/host/internal/run-context-workflow.ts"
import {
  allocateRuntimeActivityAttempt,
  agentInputEventFromRuntimeIngressRow,
  failAfterWritingRunFailed,
  readRuntimeContext,
  RuntimeContextWorkflowPayload,
  runtimeContextWorkflowExecutionId,
  StartRuntimeResultSchema,
  type RuntimeExitEvidence,
  type StartRuntimeResult,
  writeRunExitedResult,
  writeRunFailedResult,
  writeRunStarted,
} from "@firegrid/runtime/workflows"
import {
  runtimeExecutionClock,
} from "../../../../host-sdk/src/host/internal/runtime-context-helpers.ts"
import {
  RuntimeContextWorkflowRuntime,
} from "../../../../host-sdk/src/host/internal/runtime-context-workflow-runtime.ts"
import {
  RuntimeAgentToolExecutionLive,
} from "@firegrid/runtime/tool-executor"
import {
  HostRuntimeObservationSubstrateLive,
  HostRuntimeObservationStreamsLive,
  type RuntimeContextWorkflowExecutionEnv,
} from "../../../../host-sdk/src/host/runtime-substrate.ts"
import {
  RuntimeToolUseExecutorLive,
} from "../../../../host-sdk/src/agent-tools/execution/runtime-tool-use-executor-live.ts"
import {
  RuntimeContextWorkflowSession,
  runtimeInputDeferredFor,
} from "@firegrid/runtime/workflows"
import type { TinyFiregridHostEnv } from "../../types.ts"

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

interface Inv1StreamZipState {
  readonly handledInputSequence: Ref.Ref<number>
  readonly handledOutputSequence: Ref.Ref<number>
  readonly exitEvidence: Ref.Ref<RuntimeExitEvidence>
}

const workflowWaitBucketAttribute = {
  "firegrid.wait.bucket": "workflow-stream",
} as const

const startSessionActivity = (
  context: Parameters<RuntimeContextWorkflowSession["Type"]["startOrAttach"]>[0],
  activityAttempt: number,
) =>
  Activity.make({
    name: `firegrid.inv1.runtime-context.session.start.${context.contextId}.${activityAttempt}`,
    success: RuntimeContextSessionStartOutcomeSchema,
    error: Schema.Never,
    execute: Effect.gen(function*() {
      const session = yield* RuntimeContextWorkflowSession
      const evidence = yield* session.startOrAttach(context, activityAttempt)
      return { _tag: "Started" as const, evidence }
    }).pipe(
      Effect.catchAll(error => Effect.succeed({ _tag: "Failed" as const, error })),
      Effect.withSpan("firegrid.inv1.stream_zip.session.start", {
        kind: "internal",
        attributes: {
          "firegrid.context.id": context.contextId,
          "firegrid.runtime.activity_attempt": activityAttempt,
        },
      }),
    ),
  })

const sendSessionActivity = (
  context: Parameters<RuntimeContextWorkflowSession["Type"]["send"]>[0],
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
      Effect.withSpan("firegrid.inv1.stream_zip.session.send", {
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
  contextId: string,
  sequence: number,
) =>
  DurableDeferred.await(runtimeInputDeferredFor(contextId, sequence)).pipe(
    Effect.mapError(cause =>
      asRuntimeContextError(
        "inv1-stream-zip.input.await",
        "failed awaiting runtime input deferred",
        contextId,
        cause,
      )),
    Effect.withSpan("firegrid.inv1.stream_zip.input.await", {
      kind: "internal",
      attributes: {
        ...workflowWaitBucketAttribute,
        "firegrid.context.id": contextId,
        "firegrid.input.sequence": sequence,
      },
    }),
  )

const runtimeInputStream = (
  contextId: string,
): Stream.Stream<
  RuntimeIngressInputRow,
  RuntimeContextError,
  WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> =>
  Stream.unfoldEffect(0, sequence =>
    awaitRuntimeInput(contextId, sequence).pipe(
      Effect.map(row => Option.some([row, sequence + 1] as const)),
    )).pipe(
      Stream.withSpan("firegrid.inv1.stream_zip.inputs", {
        kind: "internal",
        attributes: {
          "firegrid.context.id": contextId,
        },
      }),
    )

const runtimeOutputStream = (
  contextId: string,
  activityAttempt: number,
): Stream.Stream<
  RuntimeAgentOutputObservation,
  RuntimeContextError,
  RuntimeAgentOutputAfterEvents | WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> =>
  Stream.unfoldEffect(-1, afterSequence =>
    Activity.make({
      name: `firegrid.inv1.runtime-context.output.after.${contextId}.${activityAttempt}.${afterSequence}`,
      success: RuntimeAgentOutputObservationSchema,
      error: RuntimeContextError,
      execute: Effect.gen(function*() {
        const events = yield* RuntimeAgentOutputAfterEvents
        const source = {
          _tag: "AgentOutputAfter",
          contextId,
          activityAttempt,
          afterSequence,
        } as const
        const initial = yield* events.initial(source).pipe(
          Effect.mapError(cause =>
            asRuntimeContextError(
              "inv1-stream-zip.output.initial",
              "failed checking initial runtime output observation",
              contextId,
              cause,
            )),
        )
        return yield* Option.match(initial, {
          onNone: () =>
            events.after(source).pipe(
              Stream.runHead,
              Effect.mapError(cause =>
                asRuntimeContextError(
                  "inv1-stream-zip.output.after",
                  "failed waiting for runtime output observation",
                  contextId,
                  cause,
                )),
              Effect.flatMap(match =>
                Option.match(match, {
                  onNone: () =>
                    asRuntimeContextError(
                      "inv1-stream-zip.output.after",
                      "runtime output stream ended before an observation was available",
                      contextId,
                    ),
                  onSome: observation => Effect.succeed(observation),
                })),
            ),
          onSome: observation => Effect.succeed(observation),
        }).pipe(
          Effect.withSpan("firegrid.inv1.stream_zip.output.after", {
            kind: "internal",
            attributes: {
              "firegrid.context.id": contextId,
              "firegrid.runtime.activity_attempt": activityAttempt,
              "firegrid.runtime.output.after_sequence": afterSequence,
              "firegrid.inv1.output.initial_hit": Option.isSome(initial),
            },
          }),
        )
      }),
    }).pipe(
      Effect.map(row => Option.some([row, row.sequence] as const)),
    )).pipe(
    Stream.withSpan("firegrid.inv1.stream_zip.outputs", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": contextId,
        "firegrid.runtime.activity_attempt": activityAttempt,
      },
    }),
  )

const decodeRuntimeInputEvent = (
  contextId: string,
  row: RuntimeIngressInputRow,
) =>
  agentInputEventFromRuntimeIngressRow(row).pipe(
    Effect.mapError(cause =>
      asRuntimeContextError(
        "inv1-stream-zip.input.decode",
        "failed decoding runtime input row",
        contextId,
        cause,
      )),
    Effect.withSpan("firegrid.inv1.stream_zip.input.decode", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": contextId,
        "firegrid.input.id": row.inputId,
      },
    }),
  )

const sendRuntimeInputEvent = (
  context: Parameters<RuntimeContextWorkflowSession["Type"]["send"]>[0],
  activityAttempt: number,
  row: RuntimeIngressInputRow,
  event: AgentInputEvent,
) =>
  sendSessionActivity(
    context,
    activityAttempt,
    {
      _tag: "AgentInput",
      commandId: `inv1-stream-zip-input-${context.contextId}-${row.inputId}`,
      event,
    },
    `firegrid.inv1.runtime-context.session.send.runtime-input.${row.inputId}`,
  )

const runToolUseActivity = (
  context: Parameters<RuntimeContextWorkflowSession["Type"]["send"]>[0],
  event: Extract<AgentOutputEvent, { readonly _tag: "ToolUse" }>,
) =>
  Activity.make({
    name: `firegrid.inv1.runtime-context.tool.${event.part.id}`,
    success: AgentInputEventSchema,
    error: Schema.Never,
    execute: Effect.gen(function*() {
      const executor = yield* RuntimeToolUseExecutor
      return yield* executor.execute({ contextId: context.contextId }, event)
    }).pipe(
      Effect.catchAllCause(cause =>
        Effect.succeed(toolErrorResult(
          toolExecutionFailed(
            event.part.id,
            event.part.name,
            Cause.squash(cause),
          ),
        ))),
      Effect.withSpan("firegrid.inv1.stream_zip.tool_use.activity", {
        kind: "internal",
        attributes: {
          "firegrid.context.id": context.contextId,
          "firegrid.agent_tool.name": event.part.name,
          "firegrid.agent_tool.tool_use_id": event.part.id,
        },
      }),
    ),
  })

const maybeHandlePermissionResponse = (
  context: Parameters<RuntimeContextWorkflowSession["Type"]["send"]>[0],
  activityAttempt: number,
  input: RuntimeIngressInputRow,
  inputEvent: AgentInputEvent,
  output: RuntimeAgentOutputObservation,
) =>
  Effect.gen(function*() {
    if (
      inputEvent._tag !== "PermissionResponse" ||
      output.event._tag !== "PermissionRequest" ||
      inputEvent.permissionRequestId !== output.event.permissionRequestId
    ) {
      return false
    }
    yield* sendRuntimeInputEvent(context, activityAttempt, input, inputEvent).pipe(
      withRowOtelParent(input),
      Effect.withSpan("firegrid.inv1.stream_zip.permission_response.send", {
        kind: "consumer",
        attributes: {
          "firegrid.context.id": context.contextId,
          "firegrid.runtime.activity_attempt": activityAttempt,
          "firegrid.permission.request_id": inputEvent.permissionRequestId,
          "firegrid.input.sequence": input.sequence ?? -1,
        },
      }),
    )
    return true
  })

const handleInputIfNew = (
  context: Parameters<RuntimeContextWorkflowSession["Type"]["send"]>[0],
  activityAttempt: number,
  state: Inv1StreamZipState,
  input: RuntimeIngressInputRow,
  output: RuntimeAgentOutputObservation,
) =>
  Effect.gen(function*() {
    const sequence = input.sequence ?? -1
    if (sequence <= (yield* Ref.get(state.handledInputSequence))) return
    const inputEvent = yield* decodeRuntimeInputEvent(context.contextId, input)
    const handledPermission = yield* maybeHandlePermissionResponse(
      context,
      activityAttempt,
      input,
      inputEvent,
      output,
    )
    if (!handledPermission && inputEvent._tag !== "PermissionResponse") {
      yield* sendRuntimeInputEvent(context, activityAttempt, input, inputEvent).pipe(
        withRowOtelParent(input),
      )
    }
    yield* Ref.set(state.handledInputSequence, sequence)
    yield* Effect.annotateCurrentSpan({
      "firegrid.input.sequence": sequence,
      "firegrid.agent_input.event_tag": inputEvent._tag,
      "firegrid.inv1.permission_response_matched": handledPermission,
    })
  }).pipe(
    Effect.withSpan("firegrid.inv1.stream_zip.input.handle", {
      kind: "consumer",
      attributes: {
        "firegrid.context.id": context.contextId,
        "firegrid.runtime.activity_attempt": activityAttempt,
      },
    }),
  )

const handleOutputIfNew = (
  context: Parameters<RuntimeContextWorkflowSession["Type"]["send"]>[0],
  activityAttempt: number,
  state: Inv1StreamZipState,
  output: RuntimeAgentOutputObservation,
) =>
  Effect.gen(function*() {
    if (output.sequence <= (yield* Ref.get(state.handledOutputSequence))) return
    const event = output.event
    yield* Ref.set(state.handledOutputSequence, output.sequence)
    yield* Effect.annotateCurrentSpan({
      "firegrid.agent_output.event_tag": event._tag,
      "firegrid.runtime.output.sequence": output.sequence,
    })
    if (event._tag === "ToolUse") {
      if (context.runtime.config.agentProtocol === "acp") return
      const result = yield* runToolUseActivity(context, event)
      yield* sendSessionActivity(
        context,
        activityAttempt,
        {
          _tag: "AgentInput",
          commandId: `inv1-tool-${context.contextId}-${activityAttempt}-${event.part.id}`,
          event: result,
        },
        `firegrid.inv1.runtime-context.session.send.tool-result.${event.part.id}`,
      )
    }
    if (event._tag === "Terminated") {
      yield* Ref.set(state.exitEvidence, {
        exitCode: event.exitCode ?? 0,
      })
    }
  }).pipe(
    Effect.withSpan("firegrid.inv1.stream_zip.output.handle", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": context.contextId,
        "firegrid.runtime.activity_attempt": activityAttempt,
      },
    }),
  )

const handleZipPair = (
  context: Parameters<RuntimeContextWorkflowSession["Type"]["send"]>[0],
  activityAttempt: number,
  state: Inv1StreamZipState,
  pair: readonly [RuntimeIngressInputRow, RuntimeAgentOutputObservation],
) => {
  const [input, output] = pair
  return Effect.gen(function*() {
    yield* Effect.annotateCurrentSpan({
      "firegrid.context.id": context.contextId,
      "firegrid.input.sequence": input.sequence ?? -1,
      "firegrid.runtime.output.sequence": output.sequence,
      "firegrid.agent_output.event_tag": output.event._tag,
    })
    yield* handleInputIfNew(context, activityAttempt, state, input, output)
    yield* handleOutputIfNew(context, activityAttempt, state, output)
  }).pipe(
    Effect.withSpan("firegrid.inv1.stream_zip.pair", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": context.contextId,
        "firegrid.runtime.activity_attempt": activityAttempt,
      },
    }),
  )
}

const runZipLatestBody = (
  context: Parameters<RuntimeContextWorkflowSession["Type"]["send"]>[0],
  activityAttempt: number,
): Effect.Effect<RuntimeExitEvidence, RuntimeContextError, unknown> =>
  Effect.gen(function*() {
    const state: Inv1StreamZipState = {
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
    Effect.withSpan("firegrid.inv1.stream_zip.body.run", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": context.contextId,
        "firegrid.runtime.activity_attempt": activityAttempt,
      },
    }),
  )

const runWorkflowStreamZipRuntimeContext = (
  contextId: string,
): Effect.Effect<StartRuntimeResult, RuntimeContextError, unknown> =>
  Effect.gen(function*() {
    const context = yield* readRuntimeContext(contextId)
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
    Effect.withSpan("firegrid.inv1.stream_zip.workflow.run", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": contextId,
      },
    }),
    Effect.annotateSpans("firegrid.context.id", contextId),
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
    const captured = yield* Effect.context<RuntimeContextWorkflowExecutionEnv>()
    yield* engine.register(RuntimeContextWorkflowStreamZip, ({ contextId }) =>
      runWorkflowStreamZipRuntimeContext(contextId).pipe(
        Effect.provide(captured),
      ))
  }).pipe(
    Effect.withSpan("firegrid.inv1.stream_zip.workflow.register", {
      kind: "internal",
    }),
  ),
)

const Inv1ContextRequestDaemonLive = Layer.scopedDiscard(
  Effect.gen(function*() {
    const table = yield* RuntimeControlPlaneTable
    const session = yield* CurrentHostSession
    const seen = yield* Ref.make(new Set<string>())
    yield* table.contextRequests.rows().pipe(
      Stream.runForEach(request =>
        Effect.gen(function*() {
          const alreadySeen = (yield* Ref.get(seen)).has(request.requestId)
          if (alreadySeen) return
          yield* Ref.update(seen, previous => new Set(previous).add(request.requestId))
          const createdAtMs = Date.parse(request.createdAt)
          const context = yield* makeLocalRuntimeContextForHostSession(
            session,
            normalizeRuntimeIntent(request.runtime),
            {
              contextId: request.contextId,
              createdAtMs: Number.isFinite(createdAtMs)
                ? createdAtMs
                : yield* Clock.currentTimeMillis,
              ...(request.createdBy === undefined ? {} : { createdBy: request.createdBy }),
            },
          )
          yield* table.contexts.insertOrGet(context)
        }).pipe(
          Effect.withSpan("firegrid.inv1.stream_zip.context_request", {
            kind: "consumer",
            attributes: {
              "firegrid.context.id": request.contextId,
              "firegrid.control.request_id": request.requestId,
            },
          }),
          withRowOtelParent(request),
          Effect.catchAllCause(cause =>
            Effect.logError("[tiny-firegrid] INV-1 context request failed").pipe(
              Effect.annotateLogs({
                contextId: request.contextId,
                requestId: request.requestId,
                cause,
              }),
            )),
        )),
      Effect.forkScoped,
    )
  }).pipe(
    Effect.withSpan("firegrid.inv1.stream_zip.context_request.daemon", {
      kind: "internal",
    }),
  ),
)

const streamZipWorkflowSupportLayer = (
  contextId: string,
  agentToolHost: AgentToolHostService,
): Layer.Layer<
  never,
  unknown,
  | RuntimeContextWorkflowExecutionEnv
  | AgentToolHost
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngineTable
> =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- DurableTable.layer still leaks any through substrate layers; the declared Layer R channel is the intended sim capability boundary.
  Layer.mergeAll(
    RuntimeContextWorkflowStreamZipLayer,
  ).pipe(
    Layer.provideMerge(HostRuntimeObservationSubstrateLive),
    Layer.provideMerge(
      RuntimeToolUseExecutorLive.pipe(
        Layer.provide(HostRuntimeObservationSubstrateLive),
        Layer.provideMerge(HostRuntimeObservationStreamsLive),
        Layer.provideMerge(RuntimeAgentToolExecutionLive),
      ),
    ),
    Layer.provideMerge(Layer.succeed(AgentToolHost, agentToolHost)),
    Layer.withSpan("firegrid.inv1.stream_zip.workflow_support.layer", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": contextId,
      },
    }),
  )

const startContextWithStreamZipWorkflow = (
  contextId: string,
) =>
  Effect.gen(function*() {
    const context = yield* requireLocalContext(contextId)
    const runtime = yield* RuntimeContextWorkflowRuntime
    const agentToolHost = yield* AgentToolHost
    return yield* runtime.run({
      context,
      workflowName: RuntimeContextWorkflowStreamZip.name,
      supportLayer: streamZipWorkflowSupportLayer(contextId, agentToolHost),
      effect: Effect.gen(function* () {
        const engine = yield* WorkflowEngine.WorkflowEngine
        return yield* executeRuntimeContextWorkflow(
          engine,
          RuntimeContextWorkflowStreamZip,
          {
            executionId: runtimeContextWorkflowExecutionId(contextId),
            payload: RuntimeContextWorkflowPayload.make({ contextId }),
          },
        )
      }).pipe(
        Effect.withClock(runtimeExecutionClock),
      ),
      deregisterOnExit: true,
    })
  }).pipe(
    Effect.withSpan("firegrid.inv1.stream_zip.start_context", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": contextId,
      },
    }),
    Effect.annotateSpans("firegrid.side", "host"),
  )

const Inv1StartRequestDaemonLive = Layer.scopedDiscard(
  Effect.gen(function*() {
    const table = yield* RuntimeControlPlaneTable
    const seen = yield* Ref.make(new Set<string>())
    yield* table.startRequests.rows().pipe(
      Stream.runForEach(request =>
        Effect.gen(function*() {
          const alreadySeen = (yield* Ref.get(seen)).has(request.requestId)
          if (alreadySeen) return
          yield* Ref.update(seen, previous => new Set(previous).add(request.requestId))
          yield* startContextWithStreamZipWorkflow(request.contextId).pipe(
            Effect.catchAllCause(cause =>
              Effect.logError("[tiny-firegrid] INV-1 stream zip workflow failed").pipe(
                Effect.annotateLogs({
                  contextId: request.contextId,
                  requestId: request.requestId,
                  cause,
                }),
              )),
          )
        }).pipe(
          Effect.withSpan("firegrid.inv1.stream_zip.start_request", {
            kind: "consumer",
            attributes: {
              "firegrid.context.id": request.contextId,
              "firegrid.runtime.start_request_id": request.requestId,
            },
          }),
        )),
      Effect.forkScoped,
    )
  }).pipe(
    Effect.withSpan("firegrid.inv1.stream_zip.start_request.daemon", {
      kind: "internal",
    }),
  ),
)

export const inv1StreamZipBodyHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown, never> => {
  const mcpHost = "127.0.0.1"
  const mcpPath = "/mcp"
  const host = FiregridLocalHostLive({
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
    input: true,
    controlRequestReconciler: false,
  }).pipe(
    Layer.provide(FiregridLocalProcessFromEnv(env.processEnv)),
    Layer.provide(FiregridEnvBindingsFromEnv({
      processEnv: env.processEnv,
      allow: [["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]],
    })),
  )
  const mcp = Layer.discard(
    FiregridMcpServerLayer({
      host: mcpHost,
      port: 0,
      path: ensurePathInput(mcpPath),
    }),
  )
  return Layer.mergeAll(
    mcp,
    Inv1ContextRequestDaemonLive,
    Inv1StartRequestDaemonLive,
  ).pipe(
    Layer.provideMerge(host),
  ) as Layer.Layer<FiregridHost, unknown, never>
}
