// composition/ — the Layer graph IS the topology declaration.
//
// This file does not define capabilities; it wires them. Each capability ships
// its own `*StubLayer` (production: a `*Live` layer) next to its tag. The host
// merges them. The wiring check at the bottom is the positive acceptance proof:
// providing `program` with `HostLive` erases the requirements channel to
// `never`. If any required layer were missing, `R` would not be `never` and the
// annotated `runnable` would fail to typecheck — that is "missing capability
// wiring is statically visible".

import { WorkflowEngine } from "@effect/workflow"
import { Effect, Layer } from "effect"
import type { ProtoRuntimeError } from "../errors.ts"
import type { RuntimeContextTargetEvent } from "../events/index.ts"

// Capability layers (each co-located with its tag).
import { RuntimeContextStateStoreStubLayer } from "../tables/runtime-context-state-store.ts"
import {
  RuntimeAgentOutputReadStubLayer,
  RuntimeAgentOutputWriteStubLayer,
} from "../tables/runtime-output-table.ts"
import { AgentSessionStubLayer } from "../producers/agent-session.ts"
import {
  RuntimeToolUseExecutorStubLayer,
  type ToolUseRequest,
} from "../producers/tool-use-executor.ts"
import {
  HostPromptChannelStubLayer,
  SessionAgentOutputChannelStubLayer,
} from "../channels/index.ts"

// Subscribers.
import { projectionConsumer } from "../subscribers/shape-b/projection-consumer.ts"
import { handleRuntimeContextEvent } from "../subscribers/shape-c/runtime-context-subscriber.ts"
import {
  ToolCallWorkflow,
  toolCallSubscriber,
} from "../subscribers/shape-d/tool-call-workflow.ts"

// The Shape C capability set: durable state, live boundaries, channels. NO
// workflow machinery. A correct Shape C subscriber composes to `never` against
// this layer; an Activity.make-using impostor does not (see
// ./negative-examples.ts).
export const HostLiveShapeC = Layer.mergeAll(
  RuntimeContextStateStoreStubLayer,
  RuntimeAgentOutputReadStubLayer,
  RuntimeAgentOutputWriteStubLayer,
  AgentSessionStubLayer,
  RuntimeToolUseExecutorStubLayer,
  HostPromptChannelStubLayer,
  SessionAgentOutputChannelStubLayer,
)

// Workflow substrate is present ONLY because Shape D subscribers exist. A real
// engine + a per-execution instance value (built with no casts).
const WorkflowInstanceStubLayer: Layer.Layer<WorkflowEngine.WorkflowInstance> =
  Layer.succeed(
    WorkflowEngine.WorkflowInstance,
    WorkflowEngine.WorkflowInstance.initial(ToolCallWorkflow, "proto-exec"),
  )

// The full host: Shape C plane + the workflow substrate for Shape D.
export const HostLive = Layer.mergeAll(
  HostLiveShapeC,
  WorkflowEngine.layerMemory,
  WorkflowInstanceStubLayer,
)

// A program that exercises one subscriber of each shape, so its requirements
// channel is the union of all three shapes' capabilities.
const sampleEvent: RuntimeContextTargetEvent = {
  _tag: "ToolResult",
  event: { _tag: "ToolResult", toolUseId: "t1", output: undefined },
}

const sampleToolRequest: ToolUseRequest = {
  contextId: "ctx-1",
  toolUseId: "t1",
  toolName: "noop",
  input: undefined,
}

const program = Effect.all(
  [
    projectionConsumer("ctx-1"),
    handleRuntimeContextEvent({ contextId: "ctx-1" }, sampleEvent),
    toolCallSubscriber(sampleToolRequest),
  ],
  { discard: true },
)

// POSITIVE ACCEPTANCE PROOF: the annotated `never` requirements channel only
// holds because HostLive provides every capability the subscribers name.
export const runnable: Effect.Effect<void, ProtoRuntimeError, never> =
  Effect.provide(program, HostLive)
