// Shape C RuntimeContext per-event handler.
//
// Target architecture per
// `docs/cannon/architecture/runtime-pipeline-type-boundaries.md`
// §"Shape C: Stateful Keyed Subscriber, No Workflow Machinery":
//
//   handleRuntimeContextEvent: (context, event: RuntimeContextTargetEvent) =>
//     Effect<void, RuntimeContextError,
//       RuntimeContextStateStore | AgentSession | RuntimeToolUseExecutor>
//
// The handler is a (state, event) → (newState, actions) reducer that
// materializes for ONE event, advances the durable state row via the
// `RuntimeContextStateStore`, dispatches the resulting action through typed
// capabilities, and returns. There is no entity-lifetime body, no
// `WorkflowEngine` requirement, no `DurableDeferred` mailbox, and no dense
// raw-output scan: the pure transitions (`transitionInputEvent` /
// `transitionOutputEvent` in `workflow-engine/workflows/runtime-context.ts`)
// are reused as-is.
//
// `activityAttempt` is currently part of the `RuntimeContextStateStore` row
// key, so this handler takes it explicitly. Once Shape C is the only writer of
// runtime-context state, the attempt becomes context-private (kernel-allocated)
// and can drop from the public signature; see the cutover delta doc.
//
// Tool execution: when transitionOutputEvent returns a `RunToolUse` action, the
// handler invokes `RuntimeToolUseExecutor.execute` synchronously and feeds the
// result back via `AgentSession.send`. The executor's service interface has
// been tightened (this PR) so its `execute` method does NOT propagate
// `WorkflowEngine | WorkflowInstance` to the caller's R; implementations
// internally provide their real dependencies at layer construction.

import {
  agentInputEventFromRuntimeIngressRow,
} from "../../../workflow-engine/workflows/runtime-ingress-transform.ts"
import {
  transitionInputEvent,
  transitionOutputEvent,
  type RuntimeContextTransitionAction,
} from "../../../workflow-engine/workflows/runtime-context.ts"
import {
  RuntimeContextStateStore,
  type RuntimeContextEventState,
} from "../../../workflow-engine/runtime-context-state.ts"
import {
  RuntimeToolUseExecutor,
} from "../../../workflow-engine/tool-execution/runtime-tool-use-executor.ts"
import { AgentSession } from "../../codecs/contract.ts"
import {
  type AgentInputEvent,
  type RuntimeAgentOutputObservation,
} from "../../events/index.ts"
import {
  asRuntimeContextError,
  mapRuntimeContextError,
} from "../../../runtime-errors.ts"
import type { RuntimeContextError } from "../../../runtime-errors.ts"
import type { RuntimeContext } from "@firegrid/protocol/launch"
import type { RuntimeIngressInputRow } from "@firegrid/protocol/runtime-ingress"
import { Effect, Match } from "effect"

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
// Mirrors `eventAlreadyProcessed` in the wrong-shape body but specialized to
// the target event union (no merged-event variant here).
const eventAlreadyProcessed = (
  state: RuntimeContextEventState,
  event: RuntimeContextTargetEvent,
): boolean => {
  switch (event._tag) {
    case "Input":
      return (event.event.sequence ?? -1) <= state.lastProcessedInputSequence
    case "Output":
      return event.event.sequence <= state.lastProcessedOutputSequence
    case "ToolResult":
      // ToolResult facts do not advance the cursor today: they are produced
      // inline from a ToolUse output transition. The arrival of a separately-
      // delivered ToolResult event is treated as a fresh dispatch each time;
      // AgentSession.send is the idempotency boundary downstream.
      return false
  }
}

const dispatchAction = (
  context: RuntimeContext,
  action: RuntimeContextTransitionAction,
): Effect.Effect<
  void,
  RuntimeContextError,
  AgentSession | RuntimeToolUseExecutor
> =>
  Match.value(action).pipe(
    Match.tagsExhaustive({
      None: () => Effect.void,
      SendRuntimeInput: ({ event }) => sendToSession(context, event),
      SendPermissionResponse: ({ event }) => sendToSession(context, event),
      RunToolUse: ({ output }) =>
        // ACP codecs are observation-only: the provider already executed the
        // tool. stdio-jsonl is host-result roundtrip. This guard preserves
        // the live ACP path while keeping the stdio path functional.
        // (Mirrors the dispatch guard in the wrong-shape `handleToolUseOutput`.)
        context.runtime.config.agentProtocol === "acp"
          ? Effect.void
          : runToolAndSend(context, output),
    }),
  )

const sendToSession = (
  context: RuntimeContext,
  event: AgentInputEvent,
): Effect.Effect<void, RuntimeContextError, AgentSession> =>
  Effect.gen(function*() {
    const session = yield* AgentSession
    yield* session.send(event)
  }).pipe(
    mapRuntimeContextError(
      "runtime-context.session.send",
      "failed forwarding event to agent session",
      context.contextId,
    ),
    Effect.withSpan("firegrid.runtime_context.subscriber.session.send", {
      kind: "producer",
      attributes: {
        "firegrid.context.id": context.contextId,
        "firegrid.agent_input.event_tag": event._tag,
      },
    }),
  )

const runToolAndSend = (
  context: RuntimeContext,
  output: RuntimeAgentOutputObservation,
): Effect.Effect<
  void,
  RuntimeContextError,
  AgentSession | RuntimeToolUseExecutor
> =>
  Effect.gen(function*() {
    if (output.event._tag !== "ToolUse") return
    const executor = yield* RuntimeToolUseExecutor
    const result = yield* executor.execute(
      { contextId: context.contextId },
      output.event,
    )
    yield* sendToSession(context, result)
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
// state, dispatches actions, returns. R channel is exactly the three target
// services from the type-boundaries doc; no `WorkflowEngine` appears.
export const handleRuntimeContextEvent = (
  context: RuntimeContext,
  activityAttempt: number,
  event: RuntimeContextTargetEvent,
): Effect.Effect<
  void,
  RuntimeContextError,
  RuntimeContextStateStore | AgentSession | RuntimeToolUseExecutor
> =>
  Effect.gen(function*() {
    // ToolResult facts are inline dispatches: forward to the session and
    // return. They carry no input/output cursor and do not mutate the
    // RuntimeContext durable row — the state cursor model belongs to
    // input/output. AgentSession.send is the downstream idempotency boundary.
    if (event._tag === "ToolResult") {
      yield* sendToSession(context, event.event)
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
    yield* dispatchAction(context, result.action)
    yield* stateStore.save(context, activityAttempt, result.state).pipe(
      mapRuntimeContextError(
        "runtime-context.state.save",
        "failed persisting durable runtime-context state",
        context.contextId,
      ),
    )
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
