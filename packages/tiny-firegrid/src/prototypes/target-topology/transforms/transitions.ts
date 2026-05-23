// transforms/ — pure transition functions over durable rows.
//
// These are `(state, event) -> (newState, actions)` reducers. They take no
// Effect environment and perform no I/O (Enforcement Checklist #7: callable in
// a unit test with no Effect env). The Shape C subscriber LOADS state, runs one
// of these, then SAVES + dispatches the returned actions. Keeping the decision
// logic pure is what lets the keyed handler be one-event-lived rather than a
// parked body that reconstructs progress by replay.

import type {
  RuntimeAgentOutputObservation,
  RuntimeContextTargetEvent,
} from "../events/index.ts"
import type { RuntimeContextEventState } from "../tables/runtime-context-state-store.ts"

// An action is a durable side effect the handler must dispatch through a
// capability tag. The transform names WHAT to do; it does not perform it.
export type RuntimeContextAction =
  | { readonly _tag: "AppendOutput"; readonly observation: RuntimeAgentOutputObservation }
  | { readonly _tag: "ExecuteTool"; readonly toolUseId: string }
  | { readonly _tag: "SendToAgent"; readonly text: string }

export interface RuntimeContextTransitionResult {
  readonly state: RuntimeContextEventState
  readonly actions: ReadonlyArray<RuntimeContextAction>
}

const advanceInput = (
  state: RuntimeContextEventState,
): RuntimeContextEventState => ({
  ...state,
  lastInputSequence: state.lastInputSequence + 1,
})

export const transitionInputEvent = (
  state: RuntimeContextEventState,
): RuntimeContextTransitionResult => ({
  state: advanceInput(state),
  actions: [{ _tag: "SendToAgent", text: "" }],
})

export const transitionOutputEvent = (
  state: RuntimeContextEventState,
  output: RuntimeAgentOutputObservation,
): RuntimeContextTransitionResult => ({
  state: { ...state, lastOutputSequence: output.sequence },
  actions: [{ _tag: "AppendOutput", observation: output }],
})

export const transitionToolResultEvent = (
  state: RuntimeContextEventState,
  toolUseId: string,
): RuntimeContextTransitionResult => ({
  state: {
    ...state,
    pendingToolUseIds: state.pendingToolUseIds.filter((id) => id !== toolUseId),
  },
  actions: [],
})

// Single entry the handler calls. Pure dispatch over the event union.
export const transitionRuntimeContextEvent = (
  state: RuntimeContextEventState,
  event: RuntimeContextTargetEvent,
): RuntimeContextTransitionResult => {
  switch (event._tag) {
    case "Input":
      return transitionInputEvent(state)
    case "Output":
      return transitionOutputEvent(state, event.event)
    case "ToolResult":
      return transitionToolResultEvent(state, event.event.toolUseId)
  }
}
