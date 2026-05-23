// Shape C RuntimeContext per-event handler.
//
// Target architecture per
// `docs/cannon/architecture/runtime-pipeline-type-boundaries.md`
// §"Shape C: Stateful Keyed Subscriber, No Workflow Machinery":
//
//   handleRuntimeContextEvent: (context, attempt, event) =>
//     Effect<void, RuntimeContextError,
//       RuntimeContextStateStore | RuntimeContextWorkflowSession
//       | RuntimeToolUseExecutor>
//
// The handler is a (state, event) → (newState, actions) reducer that
// materializes for ONE event, advances the durable state row via the
// `RuntimeContextStateStore`, dispatches the resulting action through typed
// capabilities, and returns. There is no entity-lifetime body, no
// `WorkflowEngine` requirement, no `DurableDeferred` mailbox, and no dense
// raw-output scan: the pure transitions (`transitionInputEvent` /
// `transitionOutputEvent` re-exported from `transforms/`) are reused as-is.
//
// Why `RuntimeContextWorkflowSession`, not `AgentSession`:
//   `AgentSession` is a live codec-scoped capability built by AcpSessionLive
//   / StdioJsonlSessionLive from `AgentByteStream`; host-sdk stores it inside
//   `CodecRuntimeContextSession` and uses it there. Making it ambient in
//   host composition would leak live codec state into durable subscriber
//   composition. `RuntimeContextWorkflowSession` is already the runtime-owned
//   inversion seam between the durable plane and the host-sdk live session
//   adapter (`startOrAttach` + `send(command)`); reusing it keeps Shape C R
//   addressed to a durable-side tag and gives host composition an existing
//   layer to satisfy.
//
// `activityAttempt` is part of both `RuntimeContextStateStore`'s row key and
// the `RuntimeContextWorkflowSession.send(context, attempt, command)` surface,
// so this handler takes it explicitly. Once Shape C is the only writer of
// runtime-context state, the attempt becomes context-private
// (kernel-allocated) and can drop from the public signature; see the cutover
// delta doc.
//
// Tool execution: when `transitionOutputEvent` returns a `RunToolUse` action,
// the handler invokes `RuntimeToolUseExecutor.execute` synchronously and
// feeds the result back through the same session-command seam. The
// executor's service interface has been tightened so its `execute` method
// does NOT propagate `WorkflowEngine | WorkflowInstance` to the caller's R;
// implementations internally provide their real dependencies at layer
// construction.
//
// Import boundary (target tree, per
// `docs/architecture/2026-05-22-runtime-physical-target-tree.md`):
//   `tables/runtime-context-state`   — durable state store + state schema
//   `transforms/runtime-context-transition`
//                                    — pure (state, event) -> (state, action)
//   `transforms/decode-ingress-row`  — pure ingress-row -> AgentInputEvent
//   `subscribers/runtime-context-session`
//                                    — session-command sink (Shape C tag)
//   `events/agent-input`             — AgentInputEvent vocabulary
//   `@firegrid/protocol/...`         — RuntimeContext, RuntimeIngressInputRow,
//                                     RuntimeAgentOutputObservation
//
// `RuntimeToolUseExecutor` is still imported from its current physical home
// in `workflow-engine/tool-execution/`. The executor is a Shape C-valid
// narrow live-dispatch capability tag (cf. the type-boundaries doc), but its
// target subpath under the new tree is not yet decided. CC for the executor
// move will retarget this import to its final home.

import { Effect, Match } from "effect"
import type { RuntimeContext } from "@firegrid/protocol/launch"
import type { RuntimeIngressInputRow } from "@firegrid/protocol/runtime-ingress"
import type { RuntimeAgentOutputObservation } from "@firegrid/protocol/session-facade"
import type { AgentInputEvent } from "../../events/agent-input.ts"
import { RuntimeRunAppendAndGet } from "../../authorities/runtime-control-plane-recorder.ts"
import {
  type RuntimeContextEventState,
  RuntimeContextStateStore,
} from "../../tables/runtime-context-state.ts"
import { agentInputEventFromRuntimeIngressRow } from "../../transforms/decode-ingress-row.ts"
import {
  type RuntimeContextTransitionAction,
  transitionInputEvent,
  transitionOutputEvent,
} from "../../transforms/runtime-context-transition.ts"
import {
  type RuntimeContextSessionCommand,
  RuntimeContextWorkflowSession,
} from "../runtime-context-session/index.ts"
import { RuntimeToolUseExecutor } from "../../workflow-engine/tool-execution/runtime-tool-use-executor.ts"
import {
  asRuntimeContextError,
  mapRuntimeContextError,
  type RuntimeContextError,
} from "../../runtime-errors.ts"

// The three sparse fact kinds a RuntimeContext subscriber observes. Mirrors
// the target shape in the type-boundaries doc §Shape C.
export type RuntimeContextTargetEvent =
  | { readonly _tag: "Input"; readonly event: RuntimeIngressInputRow }
  | { readonly _tag: "Output"; readonly event: RuntimeAgentOutputObservation }
  | {
    readonly _tag: "ToolResult"
    readonly event: Extract<AgentInputEvent, { readonly _tag: "ToolResult" }>
  }

// Idempotent skip: replays/at-least-once delivery must not double-apply.
//
// Wave D-A Shape (b) — identity-keyed input dedup (CC2 directive, validated
// by tiny-firegrid #712 GREEN). The legacy sequence-keyed gate
// `(event.event.sequence ?? -1) <= state.lastProcessedInputSequence` SILENTLY
// DROPPED THE FIRST INPUT because `RuntimeIngressInputRow` intent-derived
// rows carry no sequence (`tables/runtime-context-input-facts.ts:53-57`
// drops the allocator); `(undefined ?? -1) <= -1` is TRUE, and the cursor
// never advances because no successful transition happens. Identity-keyed
// dedup via `processedInputIds` membership is the correct shape: first
// input always delivered; restart redelivery skipped on the second pass.
//
// Outputs DO carry a kernel-allocated sequence; their dedup stays
// sequence-keyed and is correct.
const eventAlreadyProcessed = (
  state: RuntimeContextEventState,
  event: RuntimeContextTargetEvent,
): boolean => {
  switch (event._tag) {
    case "Input":
      return state.processedInputIds.includes(event.event.inputId)
    case "Output":
      return event.event.sequence <= state.lastProcessedOutputSequence
    case "ToolResult":
      // ToolResult facts do not advance the cursor today: they are produced
      // inline from a ToolUse output transition. The arrival of a separately-
      // delivered ToolResult event is treated as a fresh dispatch each time;
      // `RuntimeContextWorkflowSession.send` is the idempotency boundary
      // downstream (commandId-keyed).
      return false
  }
}

// Build a deterministic commandId for an outgoing session command. Matches the
// shape the wrong-shape body used so the host-sdk live session adapter sees
// stable ids across the cutover (input rows by inputId; tool results by
// toolUseId).
const commandIdForInputRow = (
  contextId: string,
  row: RuntimeIngressInputRow,
): string => `runtime-input-${contextId}-${row.inputId}`

const commandIdForToolResult = (
  contextId: string,
  activityAttempt: number,
  toolUseId: string,
): string => `tool-${contextId}-${activityAttempt}-${toolUseId}`

const dispatchAction = (
  context: RuntimeContext,
  activityAttempt: number,
  action: RuntimeContextTransitionAction,
): Effect.Effect<
  void,
  RuntimeContextError,
  RuntimeContextWorkflowSession | RuntimeToolUseExecutor
> =>
  Match.value(action).pipe(
    Match.tagsExhaustive({
      None: () => Effect.void,
      SendRuntimeInput: ({ row, event }) =>
        sendSessionCommand(context, activityAttempt, {
          _tag: "AgentInput",
          commandId: commandIdForInputRow(context.contextId, row),
          event,
        }),
      SendPermissionResponse: ({ row, event }) =>
        sendSessionCommand(context, activityAttempt, {
          _tag: "AgentInput",
          commandId: commandIdForInputRow(context.contextId, row),
          event,
        }),
      RunToolUse: ({ output }) =>
        // ACP codecs are observation-only: the provider already executed the
        // tool. stdio-jsonl is host-result roundtrip. This guard preserves
        // the live ACP path while keeping the stdio path functional.
        // (Mirrors the dispatch guard in the wrong-shape `handleToolUseOutput`.)
        context.runtime.config.agentProtocol === "acp"
          ? Effect.void
          : runToolAndSend(context, activityAttempt, output),
    }),
  )

const sendSessionCommand = (
  context: RuntimeContext,
  activityAttempt: number,
  command: RuntimeContextSessionCommand,
): Effect.Effect<void, RuntimeContextError, RuntimeContextWorkflowSession> =>
  Effect.gen(function*() {
    const session = yield* RuntimeContextWorkflowSession
    yield* session.send(context, activityAttempt, command)
  }).pipe(
    Effect.withSpan("firegrid.runtime_context.subscriber.session.send", {
      kind: "producer",
      attributes: {
        "firegrid.context.id": context.contextId,
        "firegrid.runtime.activity_attempt": activityAttempt,
        "firegrid.runtime.command_id": command.commandId,
        "firegrid.agent_input.event_tag": command.event._tag,
      },
    }),
  )

const runToolAndSend = (
  context: RuntimeContext,
  activityAttempt: number,
  output: RuntimeAgentOutputObservation,
): Effect.Effect<
  void,
  RuntimeContextError,
  RuntimeContextWorkflowSession | RuntimeToolUseExecutor
> =>
  Effect.gen(function*() {
    if (output.event._tag !== "ToolUse") return
    const executor = yield* RuntimeToolUseExecutor
    const result = yield* executor.execute(
      { contextId: context.contextId },
      output.event,
    )
    yield* sendSessionCommand(context, activityAttempt, {
      _tag: "AgentInput",
      commandId: commandIdForToolResult(
        context.contextId,
        activityAttempt,
        output.event.part.id,
      ),
      event: result,
    })
  }).pipe(
    Effect.withSpan("firegrid.runtime_context.subscriber.tool_use.run", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": context.contextId,
        "firegrid.agent_tool.tool_use_id":
          output.event._tag === "ToolUse" ? output.event.part.id : "",
        "firegrid.agent_tool.name":
          output.event._tag === "ToolUse" ? output.event.part.name : "",
      },
    }),
  )

// Reduce one cursor-advancing event over the durable state, producing the
// next state and the action to dispatch. Pure; identical to the body's
// transition step minus the Activity wrapper (the at-most-once Activity
// memoization is not needed in Shape C — idempotency is event-id-keyed via
// `eventAlreadyProcessed`).
//
// ToolResult is handled separately by `handleRuntimeContextEvent` and is not
// passed to this reducer: it does not advance an input or output cursor (it
// is a sibling fact produced by tool execution, not a row delivered through
// RuntimeIngress or the per-context output stream) and so does not fit the
// (state, cursor-advancing-event) → (state, action) shape the existing pure
// transitions encode.
const reduce = (
  context: RuntimeContext,
  state: RuntimeContextEventState,
  event:
    | { readonly _tag: "Input"; readonly event: RuntimeIngressInputRow }
    | { readonly _tag: "Output"; readonly event: RuntimeAgentOutputObservation },
): Effect.Effect<
  { readonly state: RuntimeContextEventState; readonly action: RuntimeContextTransitionAction },
  RuntimeContextError
> => {
  switch (event._tag) {
    case "Input":
      // The transforms/ decoder is pure (returns `Either`, which IS an Effect
      // subtype in effect@3); pass it directly to `.pipe(Effect.map/mapError)`
      // — no lift wrapper needed.
      return agentInputEventFromRuntimeIngressRow(event.event).pipe(
        Effect.map(decoded => transitionInputEvent(state, event.event, decoded)),
        Effect.mapError(cause =>
          asRuntimeContextError(
            "runtime-context.input.decode",
            "failed decoding runtime input row",
            context.contextId,
            cause,
          )),
      )
    case "Output":
      return Effect.succeed(transitionOutputEvent(context, state, event.event))
  }
}

// The Shape C per-event handler. Materializes for one event, advances durable
// state, dispatches actions, returns. R channel is exactly the four target
// services from the type-boundaries doc; no `WorkflowEngine`, no
// `AgentSession`.
//
// Wave D-A Shape (b): `RuntimeRunAppendAndGet` added because the subscriber
// owns the terminal `runs.exited` write once the workflow body retires
// (cf. `workflow-engine/workflows/runtime-context-run.ts:95-109` — the
// previous sole writer). When `transitionOutputEvent` newly sets
// `state.exitEvidence` (Terminated observation), the handler calls
// `recordExited` exactly once per (contextId, activityAttempt) — durable
// idempotency comes from `RuntimeRunEvent`'s composite primary key plus
// the state row's persistent `exitEvidence` (the next event's load sees
// the already-recorded transition and no longer triggers a write).
export const handleRuntimeContextEvent = (
  context: RuntimeContext,
  activityAttempt: number,
  event: RuntimeContextTargetEvent,
): Effect.Effect<
  void,
  RuntimeContextError,
  | RuntimeContextStateStore
  | RuntimeContextWorkflowSession
  | RuntimeToolUseExecutor
  | RuntimeRunAppendAndGet
> =>
  Effect.gen(function*() {
    // ToolResult facts are inline dispatches: forward to the session and
    // return. They carry no input/output cursor and do not mutate the
    // RuntimeContext durable row — the state cursor model belongs to
    // input/output. The session-command seam is the downstream idempotency
    // boundary (commandId-keyed).
    if (event._tag === "ToolResult") {
      yield* sendSessionCommand(context, activityAttempt, {
        _tag: "AgentInput",
        commandId: commandIdForToolResult(
          context.contextId,
          activityAttempt,
          event.event.part.id,
        ),
        event: event.event,
      })
      return
    }
    const stateStore = yield* RuntimeContextStateStore
    const state = yield* stateStore.load(context, activityAttempt).pipe(
      mapRuntimeContextError(
        "runtime-context.state.load",
        "failed loading durable runtime-context state",
        context.contextId,
      ),
    )
    if (eventAlreadyProcessed(state, event)) {
      yield* Effect.annotateCurrentSpan({
        "firegrid.runtime_context.event_skipped": true,
      })
      return
    }
    const result = yield* reduce(context, state, event)
    yield* dispatchAction(context, activityAttempt, result.action)
    yield* stateStore.save(context, activityAttempt, result.state).pipe(
      mapRuntimeContextError(
        "runtime-context.state.save",
        "failed persisting durable runtime-context state",
        context.contextId,
      ),
    )
    // Wave D-A Shape (b): when the transition newly sets `exitEvidence`
    // (Terminated observation; cf. `transforms/runtime-context-transition.ts`
    // §Terminated branch), the subscriber writes `runs.exited` — taking over
    // the terminal-row write the body's `writeRunExitedResult` did at
    // `workflow-engine/workflows/runtime-context.ts:675`. Edge-triggered on
    // the prior state being undefined; the next handler materialization
    // loads the saved row with `exitEvidence` set and never re-fires.
    if (state.exitEvidence === undefined && result.state.exitEvidence !== undefined) {
      const runs = yield* RuntimeRunAppendAndGet
      yield* runs.recordExited(context, activityAttempt, result.state.exitEvidence).pipe(
        mapRuntimeContextError(
          "runtime-context.runs.exited",
          "failed to append runs.exited row",
          context.contextId,
        ),
      )
    }
  }).pipe(
    Effect.withSpan("firegrid.runtime_context.subscriber.event.handle", {
      kind: "internal",
      attributes: {
        "firegrid.workflow.name": "RuntimeContextSubscriber",
        "firegrid.context.id": context.contextId,
        "firegrid.runtime.activity_attempt": activityAttempt,
        "firegrid.runtime_context.event_side": event._tag,
        "firegrid.seam.kind": "ordering",
        "firegrid.contract.id":
          "features/firegrid/firegrid-workflow-driven-runtime.feature.yaml",
      },
    }),
  )
