// Focused transforms/ test: transitionInputEvent / transitionOutputEvent are
// pure reducers (state, event) -> (newState, action) callable in a unit test
// with NO Effect environment — the Shape C cutover reviewer test for
// transforms/ (docs/cannon/architecture/runtime-pipeline-type-boundaries.md
// §"Enforcement Checklist" item 7).

import { describe, expect, it } from "vitest"
import { makeRuntimeIngressInputRow } from "@firegrid/protocol/runtime-ingress"
import type { RuntimeContext } from "@firegrid/protocol/launch"
import { initialRuntimeContextEventState } from "../../src/tables/runtime-context-state.ts"
import {
  transitionInputEvent,
  transitionOutputEvent,
} from "../../src/transforms/runtime-context-transition.ts"
import type {
  AgentInputEvent,
  RuntimeAgentOutputObservation,
} from "../../src/events/index.ts"

const CTX = "ctx_transition_test"
const PERMISSION_ID = "perm-1"
const TOOL_USE_ID = "tool-1"

// Narrowed RuntimeContext: the transitions read `runtime.config.agentProtocol`
// (for the ToolUse branch) and `contextId` only. A literal narrowed shape is
// sufficient here — no host wiring, no Effect, no Layer.
const stdioContext = (): RuntimeContext =>
  ({
    contextId: CTX,
    runtime: { config: { agentProtocol: "stdio_jsonl" } },
  }) as unknown as RuntimeContext

const acpContext = (): RuntimeContext =>
  ({
    contextId: CTX,
    runtime: { config: { agentProtocol: "acp" } },
  }) as unknown as RuntimeContext

const promptInput = (): AgentInputEvent => ({
  _tag: "Prompt",
  correlationId: "input-1",
  // The transitions never inspect the prompt body — a narrow stub suffices.
  prompt: { role: "user", content: [{ type: "text", text: "hi" }] } as unknown as AgentInputEvent extends { prompt: infer P } ? P : never,
})

const permissionResponse = (): AgentInputEvent => ({
  _tag: "PermissionResponse",
  permissionRequestId: PERMISSION_ID,
  decision: { _tag: "Allow" },
})

const permissionRequestObservation = (
  sequence: number,
): RuntimeAgentOutputObservation =>
  ({
    contextId: CTX,
    activityAttempt: 0,
    sequence,
    _tag: "PermissionRequest",
    event: { _tag: "PermissionRequest", permissionRequestId: PERMISSION_ID },
    permissionRequestId: PERMISSION_ID,
  }) as unknown as RuntimeAgentOutputObservation

const toolUseObservation = (
  sequence: number,
): RuntimeAgentOutputObservation =>
  ({
    contextId: CTX,
    activityAttempt: 0,
    sequence,
    _tag: "ToolUse",
    event: {
      _tag: "ToolUse",
      part: {
        id: TOOL_USE_ID,
        name: "sleep",
        params: { durationMs: 1 },
        providerExecuted: false,
      },
    },
    toolUseId: TOOL_USE_ID,
    toolName: "sleep",
  }) as unknown as RuntimeAgentOutputObservation

const terminatedObservation = (
  sequence: number,
  exitCode: number,
): RuntimeAgentOutputObservation =>
  ({
    contextId: CTX,
    activityAttempt: 0,
    sequence,
    _tag: "Terminated",
    event: { _tag: "Terminated", exitCode },
  }) as unknown as RuntimeAgentOutputObservation

describe("transforms/runtime-context-transition (pure)", () => {
  it("input: non-permission events SendRuntimeInput and advance the input cursor", () => {
    const row = makeRuntimeIngressInputRow({
      contextId: CTX,
      kind: "message",
      authoredBy: "client",
      payload: { text: "hi" },
    })

    const result = transitionInputEvent(initialRuntimeContextEventState, row, promptInput())

    expect(result.action._tag).toBe("SendRuntimeInput")
    expect(result.state.lastProcessedInputSequence).toBe(row.sequence ?? -1)
  })

  it("input: a PermissionResponse matching a pending request fires SendPermissionResponse and clears the pending request", () => {
    const row = makeRuntimeIngressInputRow({
      contextId: CTX,
      kind: "control",
      authoredBy: "client",
      payload: { permissionRequestId: PERMISSION_ID },
    })
    const state = {
      ...initialRuntimeContextEventState,
      pendingPermissionRequests: [PERMISSION_ID],
    }

    const result = transitionInputEvent(state, row, permissionResponse())

    expect(result.action._tag).toBe("SendPermissionResponse")
    if (result.action._tag === "SendPermissionResponse") {
      expect(result.action.permissionRequestId).toBe(PERMISSION_ID)
    }
    expect(result.state.pendingPermissionRequests).toEqual([])
  })

  it("input: a PermissionResponse arriving FIRST is parked into pendingPermissionResponses (action: None)", () => {
    const row = makeRuntimeIngressInputRow({
      contextId: CTX,
      kind: "control",
      authoredBy: "client",
      payload: { permissionRequestId: PERMISSION_ID },
    })

    const result = transitionInputEvent(initialRuntimeContextEventState, row, permissionResponse())

    expect(result.action._tag).toBe("None")
    expect(result.state.pendingPermissionResponses).toHaveLength(1)
    expect(result.state.pendingPermissionResponses[0]?.permissionRequestId).toBe(PERMISSION_ID)
  })

  it("output: a PermissionRequest with no pending response is parked into pendingPermissionRequests", () => {
    const result = transitionOutputEvent(
      stdioContext(),
      initialRuntimeContextEventState,
      permissionRequestObservation(3),
    )
    expect(result.action._tag).toBe("None")
    expect(result.state.pendingPermissionRequests).toEqual([PERMISSION_ID])
    expect(result.state.lastProcessedOutputSequence).toBe(3)
  })

  it("output: a PermissionRequest matching a parked response fires SendPermissionResponse and clears both pending sides", () => {
    const row = makeRuntimeIngressInputRow({
      contextId: CTX,
      kind: "control",
      authoredBy: "client",
      payload: { permissionRequestId: PERMISSION_ID },
    })
    const responded = transitionInputEvent(
      initialRuntimeContextEventState,
      row,
      permissionResponse(),
    )

    const result = transitionOutputEvent(
      stdioContext(),
      responded.state,
      permissionRequestObservation(5),
    )
    expect(result.action._tag).toBe("SendPermissionResponse")
    if (result.action._tag === "SendPermissionResponse") {
      expect(result.action.permissionRequestId).toBe(PERMISSION_ID)
      expect(result.action.row).toEqual(row)
    }
    expect(result.state.pendingPermissionResponses).toEqual([])
  })

  it("output: ToolUse under stdio_jsonl emits RunToolUse; under acp it falls through to action: None", () => {
    const stdioResult = transitionOutputEvent(
      stdioContext(),
      initialRuntimeContextEventState,
      toolUseObservation(7),
    )
    expect(stdioResult.action._tag).toBe("RunToolUse")

    const acpResult = transitionOutputEvent(
      acpContext(),
      initialRuntimeContextEventState,
      toolUseObservation(7),
    )
    expect(acpResult.action._tag).toBe("None")
  })

  it("output: Terminated records exit evidence and emits action: None", () => {
    const result = transitionOutputEvent(
      stdioContext(),
      initialRuntimeContextEventState,
      terminatedObservation(9, 0),
    )
    expect(result.action._tag).toBe("None")
    expect(result.state.exitEvidence).toEqual({ exitCode: 0 })
  })

  it("output: inert tags advance the output cursor with action: None", () => {
    const observation = {
      contextId: CTX,
      activityAttempt: 0,
      sequence: 11,
      _tag: "TextChunk",
      event: { _tag: "TextChunk", text: "hi" },
    } as unknown as RuntimeAgentOutputObservation

    const result = transitionOutputEvent(
      stdioContext(),
      initialRuntimeContextEventState,
      observation,
    )
    expect(result.action._tag).toBe("None")
    expect(result.state.lastProcessedOutputSequence).toBe(11)
  })
})
