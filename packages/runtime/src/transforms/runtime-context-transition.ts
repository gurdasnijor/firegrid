// Pure RuntimeContext state transitions.
//
// Logical pipeline position: transforms/ (peer of producers, channels).
// Pure: no Effect, no Layer, no Context.Tag, no Workflow, no Activity, no
// DurableDeferred, no DurableClock, no table tags, no channel tags. Every
// exported value is callable in a unit test with no Effect environment
// (docs/cannon/architecture/runtime-pipeline-type-boundaries.md
// §"Enforcement Checklist" item 7).
//
// Moved here from `workflow-engine/workflows/runtime-context.ts` under the
// Shape C cutover physical target tree
// (docs/architecture/2026-05-22-runtime-physical-target-tree.md). The
// workflow-engine module retains the side-effecting body that wraps these
// transitions inside `Activity.make` (durable memoization seam); see also
// `agent-event-pipeline/subscribers/runtime-context/handler.ts` (Shape C
// per-event handler) which calls these transitions directly.
//
// The transitions are the deterministic reducer:
//
//   (state, event) -> (newState, action)
//
// They are the C2/C5 reducer-shape factoring named by
// docs/cannon/architecture/runtime-design-constraints.md as the load-bearing
// logic the Shape C subscriber reuses.

import { Schema } from "effect"
import {
  RuntimeIngressInputRowSchema,
  type RuntimeIngressInputRow,
} from "@firegrid/protocol/runtime-ingress"
import type { RuntimeContext } from "@firegrid/protocol/launch"
import {
  AgentInputEventSchema,
  type AgentInputEvent,
} from "../events/agent-input.ts"
import {
  AgentOutputEventSchema,
  type RuntimeAgentOutputObservation,
} from "../events/agent-output.ts"
import {
  RuntimeContextEventStateSchema,
  type RuntimeContextEventState,
  type PendingPermissionResponse,
} from "../events/runtime-context-state.ts"

// Reconstructed here from its event-vocabulary parts so transforms/ does not
// import the Effect-bearing runtime-context module. The cast preserves the
// original Schema.Schema<RuntimeAgentOutputObservation> branding used by the
// action schema below.
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

export const RuntimeContextTransitionActionSchema = Schema.Union(
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

export const RuntimeContextTransitionResultSchema = Schema.Struct({
  state: RuntimeContextEventStateSchema,
  action: RuntimeContextTransitionActionSchema,
})
export type RuntimeContextTransitionResult = Schema.Schema.Type<
  typeof RuntimeContextTransitionResultSchema
>

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

// Pure state transition for an input event.
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

// Pure state transition for an output observation.
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
