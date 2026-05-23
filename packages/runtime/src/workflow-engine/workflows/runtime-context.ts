import {
  Activity,
  DurableDeferred,
  Workflow,
  WorkflowEngine,
} from "@effect/workflow"
import { Prompt } from "@effect/ai"
import type { RuntimeContext } from "@firegrid/protocol/launch"
import {
  RuntimeIngressInputRowSchema,
  type RuntimeIngressInputRow,
} from "@firegrid/protocol/runtime-ingress"
import { withRowOtelParent } from "@firegrid/protocol/otel"
import { withActivityContract } from "../internal/contract-activity.ts"
import {
  Cause,
  Effect,
  Layer,
  Option,
  Predicate,
  Ref,
  Schema,
} from "effect"
import type { Scope } from "effect"
import type {
  RuntimeContextRead,
  RuntimeRunAppendAndGet,
} from "../../authorities/index.ts"
import {
  AgentInputEventSchema,
  AgentOutputEventSchema,
  type AgentInputEvent,
  type AgentOutputEvent,
  type RuntimeAgentOutputObservation,
} from "../../agent-event-pipeline/events/index.ts"
import {
  RuntimeContextStateStore,
  RuntimeContextEventStateSchema,
  type RuntimeContextEventState,
  type PendingPermissionResponse,
} from "../../tables/runtime-context-state.ts"
import {
  RuntimeContextError,
  asRuntimeContextError,
} from "../../runtime-errors.ts"
import {
  RuntimeToolUseExecutor,
} from "../tool-execution/runtime-tool-use-executor.ts"
import {
  readRuntimeContext,
  runtimeContextWorkflowExecutionId,
} from "./runtime-context-run.ts"
import { agentInputEventFromRuntimeIngressRow } from "./runtime-ingress-transform.ts"
import {
  type StartRuntimeResult,
  RuntimeContextWorkflowPayload,
  StartRuntimeResultSchema,
  allocateRuntimeActivityAttempt,
  failAfterWritingRunFailed,
  writeRunExitedResult,
  writeRunFailedResult,
  writeRunStarted,
} from "./runtime-context-run.ts"
// Wave 2 (Shape C): the codec-session command sink contract lives in the
// `subscribers/runtime-context-session/` target folder. The parked workflow
// body imports the seam from there; the seam does not import the body.
import {
  RuntimeContextSessionCommandAcceptedSchema,
  RuntimeContextSessionStartOutcomeSchema,
  RuntimeContextWorkflowSession,
  type RuntimeContextSessionCommand,
} from "../../subscribers/runtime-context-session/handler.ts"

export type RuntimeContextWorkflowExecutionEnv =
  | RuntimeContextRead
  | RuntimeRunAppendAndGet
  | RuntimeContextStateStore
  | RuntimeToolUseExecutor
  | RuntimeContextWorkflowSession
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance
  | Scope.Scope

const startSessionActivity = (
  context: RuntimeContext,
  activityAttempt: number,
) =>
  Activity.make({
    name: `firegrid.runtime-context.session.start.${context.contextId}.${activityAttempt}`,
    success: RuntimeContextSessionStartOutcomeSchema,
    error: Schema.Never,
    execute: Effect.gen(function*() {
      const session = yield* RuntimeContextWorkflowSession
      // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.5
      // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.7
      const evidence = yield* session.startOrAttach(context, activityAttempt)
      return { _tag: "Started" as const, evidence }
    }).pipe(
      Effect.catchAll(error => Effect.succeed({ _tag: "Failed" as const, error })),
      Effect.withSpan("firegrid.runtime_context.workflow.session.start", {
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
      // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.5
      return yield* session.send(context, activityAttempt, command)
    }).pipe(
      Effect.withSpan("firegrid.runtime_context.workflow.session.send", {
        kind: "internal",
        attributes: {
          "firegrid.context.id": context.contextId,
          "firegrid.runtime.activity_attempt": activityAttempt,
          "firegrid.runtime.command_id": command.commandId,
        },
      }),
    ),
  })

const inputWaitName = (
  contextId: string,
  sequence: number,
) => `runtime-context/${contextId}/input/${sequence}`

const workflowWaitBucketAttribute = {
  "firegrid.wait.bucket": "workflow",
} as const

export const runtimeInputDeferredName = inputWaitName

export const runtimeInputDeferredFor = (
  contextId: string,
  sequence: number,
) =>
  DurableDeferred.make(inputWaitName(contextId, sequence), {
    success: RuntimeIngressInputRowSchema,
  })

const awaitRuntimeInput = (
  context: RuntimeContext,
  sequence: number,
) =>
  DurableDeferred.await(runtimeInputDeferredFor(context.contextId, sequence)).pipe(
    Effect.withSpan("firegrid.runtime_context.workflow.input.await", {
      kind: "internal",
      attributes: {
        ...workflowWaitBucketAttribute,
        "firegrid.context.id": context.contextId,
        "firegrid.input.sequence": sequence,
      },
    }),
  )

const completedRuntimeInput = (
  context: RuntimeContext,
  sequence: number,
) =>
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine
    const exit = yield* Workflow.wrapActivityResult(
      engine.deferredResult(runtimeInputDeferredFor(context.contextId, sequence)),
      Predicate.isUndefined,
    )
    if (exit === undefined) return undefined
    return yield* exit
  }).pipe(
    Effect.withSpan("firegrid.runtime_context.workflow.input.completed", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": context.contextId,
        "firegrid.input.sequence": sequence,
        // Seam contract (runtime-shrink contract-coverage, tf-mmh2): replay-safe
        // delivery of the next inbound input — reads the per-sequence runtime
        // input DurableDeferred so the body observes input exactly once across
        // replay (firegrid-workflow-driven-runtime; engine durability via
        // workflow-engine-durable-state.VALIDATION.2).
        "firegrid.seam.kind": "durability",
        "firegrid.contract.id": "features/firegrid/firegrid-workflow-driven-runtime.feature.yaml",
      },
    }),
  )

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

type RuntimeContextMergedEvent =
  | { readonly _tag: "Input"; readonly event: RuntimeIngressInputRow }
  | { readonly _tag: "Output"; readonly event: RuntimeAgentOutputObservation }

const RuntimeContextTransitionActionSchema = Schema.Union(
  Schema.TaggedStruct("None", {}),
  Schema.TaggedStruct("SendRuntimeInput", {
    row: RuntimeIngressInputRowSchema,
    event: AgentInputEventSchema,
  }),
  Schema.TaggedStruct("SendPermissionResponse", {
    permissionRequestId: Schema.String,
    row: RuntimeIngressInputRowSchema,
    event: AgentInputEventSchema,
  }),
  Schema.TaggedStruct("RunToolUse", {
    output: RuntimeAgentOutputObservationSchema,
  }),
)
export type RuntimeContextTransitionAction = Schema.Schema.Type<
  typeof RuntimeContextTransitionActionSchema
>

const RuntimeContextTransitionResultSchema = Schema.Struct({
  state: RuntimeContextEventStateSchema,
  action: RuntimeContextTransitionActionSchema,
})
type RuntimeContextTransitionResult = Schema.Schema.Type<
  typeof RuntimeContextTransitionResultSchema
>

const toolExecutionFailed = (
  toolUseId: string,
  name: string,
  cause: unknown,
) => {
  const message = cause instanceof Error
    ? cause.message
    : typeof cause === "string"
    ? cause
    : cause === undefined
    ? "no cause"
    : JSON.stringify(cause) ?? "[unprintable cause]"
  return {
    _tag: "ToolExecutionFailed" as const,
    toolUseId,
    name,
    message,
    ...(cause === undefined ? {} : { cause }),
  }
}

const toolErrorResult = (
  error: ReturnType<typeof toolExecutionFailed>,
): Extract<AgentInputEvent, { readonly _tag: "ToolResult" }> => ({
  _tag: "ToolResult",
  part: Prompt.toolResultPart({
    id: error.toolUseId,
    name: error.name,
    result: {
      error,
      message: `Tool "${error.name}" execution failed: ${error.message}`,
    },
    isFailure: true,
    providerExecuted: false,
  }),
})

const runToolUseActivity = (
  context: RuntimeContext,
  event: Extract<AgentOutputEvent, { readonly _tag: "ToolUse" }>,
) =>
  Activity.make({
    name: `firegrid.runtime-context.tool.${event.part.id}`,
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
      Effect.withSpan("firegrid.runtime_context.workflow.tool_use.activity", {
        kind: "internal",
        attributes: {
          "firegrid.context.id": context.contextId,
          "firegrid.agent_tool.name": event.part.name,
          "firegrid.agent_tool.tool_use_id": event.part.id,
        },
      }),
    ),
  })

const decodeRuntimeInputEvent = (
  context: RuntimeContext,
  row: RuntimeIngressInputRow,
) =>
  agentInputEventFromRuntimeIngressRow(row).pipe(
    Effect.mapError(cause =>
      asRuntimeContextError(
        "runtime-context.input.decode",
        "failed decoding runtime input row",
        context.contextId,
        cause,
      )),
    Effect.withSpan("firegrid.runtime_context.workflow.input.decode", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": context.contextId,
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
      commandId: `runtime-input-${context.contextId}-${row.inputId}`,
      event,
    },
    `firegrid.runtime-context.session.send.runtime-input.${row.inputId}`,
  )

const handleToolUseOutput = (
  context: RuntimeContext,
  activityAttempt: number,
  observation: RuntimeAgentOutputObservation,
) =>
  Effect.gen(function*() {
    const event = observation.event
    yield* Effect.annotateCurrentSpan({
      "firegrid.agent_output.event_tag": event._tag,
      "firegrid.runtime.output.sequence": observation.sequence,
    })
    if (event._tag === "ToolUse") {
      // TFIND-041 (decided): session/codec mode is the INTENTIONAL,
      // by-decision authority for the ToolUse execution lifecycle — it is
      // not an accident of "by default". ACP codecs are observation-only
      // (the host does not execute the tool; the provider already did), so
      // the workflow skips `RuntimeToolUseExecutor` here; stdio-jsonl is
      // client-result roundtrip (the host executes and feeds the result
      // back). The `AgentOutput` ToolUse event is deliberately NOT
      // discriminated by execution authority; interpretation stays
      // codec/session-aware on purpose. Promoting an event-level
      // discriminant (option A: `ToolUseRequest` vs `ToolUseObservation`)
      // is a tracked, deliberately-deferred future option, not the
      // current contract.
      if (context.runtime.config.agentProtocol === "acp") {
        return
      }
      const result = yield* runToolUseActivity(context, event)
      yield* sendSessionActivity(
        context,
        activityAttempt,
        {
          _tag: "AgentInput",
          commandId: `tool-${context.contextId}-${activityAttempt}-${event.part.id}`,
          event: result,
        },
        `firegrid.runtime-context.session.send.tool-result.${event.part.id}`,
      )
    }
  }).pipe(
    Effect.withSpan("firegrid.runtime_context.workflow.output.handle", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": context.contextId,
        "firegrid.runtime.activity_attempt": activityAttempt,
      },
    }),
  )

const handleRuntimeInput = (
  context: RuntimeContext,
  activityAttempt: number,
  row: RuntimeIngressInputRow,
  event: AgentInputEvent,
) =>
  sendRuntimeInputEvent(context, activityAttempt, row, event).pipe(
    Effect.withSpan("firegrid.runtime_context.workflow.input.handle", {
      kind: "consumer",
      attributes: {
        "firegrid.context.id": context.contextId,
        "firegrid.runtime.activity_attempt": activityAttempt,
        "firegrid.input.id": row.inputId,
        "firegrid.input.sequence": row.sequence ?? -1,
      },
    }),
    // Parent this input handle (and everything it sends downstream) to the
    // original client.prompt producer span recorded on the row.
    withRowOtelParent(row),
  )

const withoutPermissionRequest = (
  state: RuntimeContextEventState,
  permissionRequestId: string,
) => state.pendingPermissionRequests.filter(id => id !== permissionRequestId)

const withPermissionRequest = (
  state: RuntimeContextEventState,
  permissionRequestId: string,
) =>
  state.pendingPermissionRequests.includes(permissionRequestId)
    ? state.pendingPermissionRequests
    : [...state.pendingPermissionRequests, permissionRequestId]

const withoutPermissionResponse = (
  state: RuntimeContextEventState,
  permissionRequestId: string,
) =>
  state.pendingPermissionResponses.filter(response =>
    response.permissionRequestId !== permissionRequestId)

const withPermissionResponse = (
  state: RuntimeContextEventState,
  response: PendingPermissionResponse,
) => [
  ...withoutPermissionResponse(state, response.permissionRequestId),
  response,
]

// Exported for focused tests: pure state transition for an input event.
export const transitionInputEvent = (
  state: RuntimeContextEventState,
  row: RuntimeIngressInputRow,
  event: AgentInputEvent,
): RuntimeContextTransitionResult => {
  const sequence = row.sequence ?? -1
  const nextState = {
    ...state,
    lastProcessedInputSequence: sequence,
  }
  if (event._tag !== "PermissionResponse") {
    return {
      state: nextState,
      action: { _tag: "SendRuntimeInput", row, event },
    }
  }

  if (state.pendingPermissionRequests.includes(event.permissionRequestId)) {
    return {
      state: {
        ...nextState,
        pendingPermissionRequests: withoutPermissionRequest(state, event.permissionRequestId),
      },
      action: {
        _tag: "SendPermissionResponse",
        permissionRequestId: event.permissionRequestId,
        row,
        event,
      },
    }
  }

  return {
    state: {
      ...nextState,
      pendingPermissionResponses: withPermissionResponse(state, {
        permissionRequestId: event.permissionRequestId,
        row,
        event,
      }),
    },
    action: { _tag: "None" },
  }
}

// Exported for focused tests: pure state transition for an output observation.
export const transitionOutputEvent = (
  context: RuntimeContext,
  state: RuntimeContextEventState,
  output: RuntimeAgentOutputObservation,
): RuntimeContextTransitionResult => {
  const nextState = {
    ...state,
    lastProcessedOutputSequence: output.sequence,
  }
  const event = output.event
  if (event._tag === "PermissionRequest") {
    const pendingResponse = state.pendingPermissionResponses.find(response =>
      response.permissionRequestId === event.permissionRequestId)
    if (pendingResponse !== undefined) {
      return {
        state: {
          ...nextState,
          pendingPermissionRequests: withoutPermissionRequest(state, event.permissionRequestId),
          pendingPermissionResponses: withoutPermissionResponse(state, event.permissionRequestId),
        },
        action: {
          _tag: "SendPermissionResponse",
          permissionRequestId: event.permissionRequestId,
          row: pendingResponse.row,
          event: pendingResponse.event,
        },
      }
    }
    return {
      state: {
        ...nextState,
        pendingPermissionRequests: withPermissionRequest(state, event.permissionRequestId),
      },
      action: { _tag: "None" },
    }
  }
  if (event._tag === "ToolUse" && context.runtime.config.agentProtocol !== "acp") {
    return {
      state: nextState,
      action: { _tag: "RunToolUse", output },
    }
  }
  if (event._tag === "Terminated") {
    return {
      state: {
        ...nextState,
        exitEvidence: {
          exitCode: event.exitCode ?? 0,
        },
      },
      action: { _tag: "None" },
    }
  }
  return {
    state: nextState,
    action: { _tag: "None" },
  }
}

const transitionActivityName = (
  contextId: string,
  activityAttempt: number,
  state: RuntimeContextEventState,
  event: RuntimeContextMergedEvent,
) => {
  const side = event._tag === "Input" ? "input" : "output"
  const sequence = event._tag === "Input"
    ? event.event.sequence ?? -1
    : event.event.sequence
  return `firegrid.runtime-context.state.${contextId}.${activityAttempt}.${side}.${sequence}.after.${
    state.lastProcessedInputSequence
  }.${state.lastProcessedOutputSequence}`
}

const runtimeContextEventSpanAttributes = (
  context: RuntimeContext,
  activityAttempt: number,
  event: RuntimeContextMergedEvent,
) => ({
  "firegrid.context.id": context.contextId,
  "firegrid.runtime.activity_attempt": activityAttempt,
  "firegrid.runtime_context.event_side": event._tag,
  "firegrid.input.sequence": event._tag === "Input" ? event.event.sequence ?? -1 : -1,
  "firegrid.runtime.output.sequence": event._tag === "Output" ? event.event.sequence : -1,
}) as const

const transitionRuntimeContextEventActivity = (
  context: RuntimeContext,
  activityAttempt: number,
  state: RuntimeContextEventState,
  event: RuntimeContextMergedEvent,
) =>
  // Two seams on one durable transition step:
  //  - the Activity-name span (`firegrid.runtime-context.state.*.after.*`) is the
  //    durable at-most-once transition memoization keyed on cursor state =
  //    DURABILITY. It is created by vendored Activity.make, so the engine
  //    annotates it via withActivityContract (tf-vw29; see contract-activity.ts).
  //  - the inner `state.transition` span is the deterministic state-machine
  //    reduction (event, state) -> (nextState, action) = a pure TRANSFORM (tf-mmh2).
  // (both: firegrid-workflow-driven-runtime).
  withActivityContract(
    Activity.make({
      name: transitionActivityName(context.contextId, activityAttempt, state, event),
      success: RuntimeContextTransitionResultSchema,
      error: RuntimeContextError,
      execute: Effect.gen(function*() {
        if (event._tag === "Input") {
          const decoded = yield* decodeRuntimeInputEvent(context, event.event)
          return transitionInputEvent(state, event.event, decoded)
        }
        return transitionOutputEvent(context, state, event.event)
      }).pipe(
        Effect.withSpan("firegrid.runtime_context.workflow.state.transition", {
          kind: "internal",
          attributes: {
            ...runtimeContextEventSpanAttributes(context, activityAttempt, event),
            "firegrid.seam.kind": "transform",
            "firegrid.contract.id": "features/firegrid/firegrid-workflow-driven-runtime.feature.yaml",
          },
        }),
      ),
    }),
    {
      seamKind: "durability",
      contractId: "features/firegrid/firegrid-workflow-driven-runtime.feature.yaml",
    },
  )

const applyRuntimeContextTransitionAction = (
  context: RuntimeContext,
  activityAttempt: number,
  action: RuntimeContextTransitionAction,
) => {
  switch (action._tag) {
    case "None":
      return Effect.void
    case "SendRuntimeInput":
      return handleRuntimeInput(context, activityAttempt, action.row, action.event)
    case "SendPermissionResponse":
      return sendRuntimeInputEvent(context, activityAttempt, action.row, action.event).pipe(
        withRowOtelParent(action.row),
        Effect.withSpan("firegrid.runtime_context.workflow.permission_response.send", {
          kind: "consumer",
          attributes: {
            "firegrid.context.id": context.contextId,
            "firegrid.runtime.activity_attempt": activityAttempt,
            "firegrid.permission.request_id": action.permissionRequestId,
            "firegrid.input.sequence": action.row.sequence ?? -1,
          },
        }),
      )
    case "RunToolUse":
      return handleToolUseOutput(context, activityAttempt, action.output)
  }
}

const eventAlreadyProcessed = (
  state: RuntimeContextEventState,
  event: RuntimeContextMergedEvent,
) =>
  event._tag === "Input"
    ? (event.event.sequence ?? -1) <= state.lastProcessedInputSequence
    : event.event.sequence <= state.lastProcessedOutputSequence

const completedRuntimeContextEvent = (
  context: RuntimeContext,
  activityAttempt: number,
  state: RuntimeContextEventState,
  stateStore: RuntimeContextStateStore["Type"],
) =>
  Effect.gen(function*() {
    const input = yield* completedRuntimeInput(
      context,
      state.lastProcessedInputSequence + 1,
    )
    if (input !== undefined) {
      return Option.some<RuntimeContextMergedEvent>({ _tag: "Input", event: input })
    }
    // Output observation is a durable-cursor point read at
    // `lastProcessedOutputSequence + 1` (no live scan, no replay re-walk;
    // tf-aseo / SDD_DURABLE_OUTPUT_CURSOR_PRIMITIVE INV-3).
    const output = yield* stateStore.nextOutput(
      context,
      activityAttempt,
      state.lastProcessedOutputSequence,
    ).pipe(
      Effect.mapError(cause =>
        asRuntimeContextError(
          "runtime-context.output.cursor",
          "failed reading next runtime output observation",
          context.contextId,
          cause,
        )),
    )
    return Option.map(output, (event): RuntimeContextMergedEvent => ({ _tag: "Output", event }))
  })

const awaitNextRuntimeContextEvent = (
  context: RuntimeContext,
  state: RuntimeContextEventState,
) =>
  awaitRuntimeInput(context, state.lastProcessedInputSequence + 1).pipe(
    Effect.map(event => ({ _tag: "Input" as const, event })),
    Effect.withSpan("firegrid.runtime_context.workflow.event.await", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": context.contextId,
        "firegrid.input.sequence": state.lastProcessedInputSequence + 1,
      },
    }),
  )

const handleRuntimeContextEvent = (
  context: RuntimeContext,
  activityAttempt: number,
  stateRef: Ref.Ref<RuntimeContextEventState>,
  event: RuntimeContextMergedEvent,
) =>
  Effect.gen(function*() {
    const current = yield* Ref.get(stateRef)
    if (eventAlreadyProcessed(current, event)) {
      yield* Effect.annotateCurrentSpan({
        "firegrid.runtime_context.event_skipped": true,
      })
      return true
    }
    const transition = yield* transitionRuntimeContextEventActivity(
      context,
      activityAttempt,
      current,
      event,
    )
    yield* applyRuntimeContextTransitionAction(context, activityAttempt, transition.action)
    yield* Ref.set(stateRef, transition.state)
    return transition.state.exitEvidence === undefined
  }).pipe(
    Effect.withSpan("firegrid.runtime_context.workflow.event.handle", {
      kind: "internal",
      attributes: {
        ...runtimeContextEventSpanAttributes(context, activityAttempt, event),
        // Seam contract (runtime-shrink contract-coverage, tf-mmh2): ordering —
        // the merged input/output event loop processes events in monotonic
        // sequence and idempotently skips any event at or below the last
        // processed sequence (eventAlreadyProcessed), so replay re-delivery does
        // not double-apply a transition (firegrid-workflow-driven-runtime).
        "firegrid.seam.kind": "ordering",
        "firegrid.contract.id": "features/firegrid/firegrid-workflow-driven-runtime.feature.yaml",
      },
    }),
  )

const runMergedEventLoop = (
  context: RuntimeContext,
  activityAttempt: number,
) =>
  Effect.gen(function*() {
    const stateStore = yield* RuntimeContextStateStore
    // tf-aseo: reconstruct loop progress from the workflow-owned durable state
    // row with one point read. On replay/resume the body resumes from the saved
    // cursors + pending-permission sets instead of re-walking the output
    // history (the tf-7kq8 re-walk; SDD INV-1/INV-2).
    const stateRef = yield* Ref.make(
      yield* stateStore.load(context, activityAttempt).pipe(
        Effect.mapError(cause =>
          asRuntimeContextError(
            "runtime-context.state.load",
            "failed loading durable runtime-context loop state",
            context.contextId,
            cause,
          )),
      ),
    )
    const persistState = Effect.suspend(() =>
      Ref.get(stateRef).pipe(
        Effect.flatMap(current => stateStore.save(context, activityAttempt, current)),
        Effect.mapError(cause =>
          asRuntimeContextError(
            "runtime-context.state.save",
            "failed persisting durable runtime-context loop state",
            context.contextId,
            cause,
          )),
      ))
    let shouldContinue = (yield* Ref.get(stateRef)).exitEvidence === undefined
    while (shouldContinue) {
      const state = yield* Ref.get(stateRef)
      const completed = yield* completedRuntimeContextEvent(context, activityAttempt, state, stateStore)
      // Persist the advanced cursor + pending-permission sets at the suspension
      // boundary (when no event is ready) BEFORE blocking, so a resume reloads
      // progress with one point read instead of re-walking outputs. Side
      // effects are all memoized activities, so re-running an unsaved tail after
      // a crash is idempotent (tf-aseo durability/ordering invariant).
      const event = Option.isSome(completed)
        ? completed.value
        : yield* persistState.pipe(
          Effect.zipRight(awaitNextRuntimeContextEvent(context, state)),
        )
      shouldContinue = yield* handleRuntimeContextEvent(
        context,
        activityAttempt,
        stateRef,
        event,
      )
    }
    yield* persistState
    const state = yield* Ref.get(stateRef)
    return state.exitEvidence ?? { exitCode: 0 }
  }).pipe(
    Effect.withSpan("firegrid.runtime_context.workflow.event_stream.run", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": context.contextId,
        "firegrid.runtime.activity_attempt": activityAttempt,
      },
    }),
  )

const runWorkflowNativeRuntimeContext = (
  contextId: string,
): Effect.Effect<StartRuntimeResult, RuntimeContextError, unknown> =>
  Effect.gen(function*() {
    const context = yield* readRuntimeContext(contextId)
    const activityAttempt = yield* allocateRuntimeActivityAttempt(context)
    yield* writeRunStarted(context, activityAttempt)
    const exit = yield* Effect.gen(function*() {
      // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.6
      const start = yield* startSessionActivity(context, activityAttempt)
      if (start._tag === "Failed") {
        return yield* writeRunFailedResult(context, activityAttempt, start.error)
      }
      return yield* runMergedEventLoop(context, activityAttempt)
    }).pipe(
      Effect.catchAll(failAfterWritingRunFailed(context, activityAttempt)),
    )
    if ("failure" in exit && exit.failure !== undefined) return exit
    return yield* writeRunExitedResult(context, activityAttempt, exit)
  }).pipe(
    Effect.withSpan("firegrid.runtime_context.workflow.native.run", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": contextId,
      },
    }),
    Effect.annotateSpans("firegrid.context.id", contextId),
  )

export const RuntimeContextWorkflowNative = Workflow.make({
  name: "firegrid.runtime-context",
  payload: RuntimeContextWorkflowPayload,
  success: StartRuntimeResultSchema,
  error: RuntimeContextError,
  idempotencyKey: ({ contextId }) => runtimeContextWorkflowExecutionId(contextId),
}).annotate(Workflow.SuspendOnFailure, true)

export const RuntimeContextWorkflowNativeLayer = Layer.scopedDiscard(
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine
    // TFIND-031 (Option Y): capture the execution-scoped workflow
    // substrate — host ambient tags PLUS the durable-wait family, which
    // `runtimeContextWorkflowSupportLayer` provides around this layer
    // via `HostRuntimeObservationSubstrateLive` (one shared materialized
    // store; see SDD proof). Deferred handler runs later, outside this
    // gen, so it must re-provide the captured substrate. `never` was
    // only sound while `DurableTable.layer` leaked `any`.
    const captured = yield* Effect.context<RuntimeContextWorkflowExecutionEnv>()
    yield* engine.register(RuntimeContextWorkflowNative, ({ contextId }) =>
      runWorkflowNativeRuntimeContext(contextId).pipe(
        Effect.provide(captured),
      ))
  }).pipe(
    Effect.withSpan("firegrid.runtime_context.workflow.native.register", {
      kind: "internal",
    }),
  ),
)
