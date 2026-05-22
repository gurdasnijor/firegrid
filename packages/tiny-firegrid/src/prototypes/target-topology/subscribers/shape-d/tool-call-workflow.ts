// Shape D: Workflow-shaped subscriber. Earns workflow execution machinery.
//
//   R = RuntimeToolUseExecutor          (live side-effecting executor)
//     | WorkflowEngine.WorkflowEngine    (the VISIBLE Shape D signal)
//     | WorkflowEngine.WorkflowInstance
//
// The machinery is justified by C3: the tool result is a durable completion
// keyed by `toolUseId`, and the external effect must run at most once across a
// crash. `Activity.make` is what supplies that at-most-once boundary, and it is
// `Activity.make` that grows `WorkflowEngine` / `WorkflowInstance` into `R`.
// That growth is the load-bearing fact behind the negative proof in
// ../../composition/negative-examples.ts: any subscriber that calls
// `Activity.make` cannot also claim to be Shape C.

import { Activity, Workflow, type WorkflowEngine } from "@effect/workflow"
import { Effect, Schema } from "effect"
import type { ToolResultEvent } from "../../events/index.ts"
import {
  RuntimeToolUseExecutor,
  type ToolUseRequest,
} from "../../producers/tool-use-executor.ts"

// The workflow identity. Payload is ONE tool call (not a RuntimeContext
// lifetime); the idempotency key is the `toolUseId` result identity (C3/C4).
export const ToolCallWorkflow = Workflow.make({
  name: "proto.agent-tool-call",
  payload: Schema.Struct({
    contextId: Schema.String,
    toolUseId: Schema.String,
  }),
  success: Schema.Void,
  idempotencyKey: (payload) => payload.toolUseId,
})

export const toolCallSubscriber = (
  request: ToolUseRequest,
): Effect.Effect<
  ToolResultEvent,
  never,
  | RuntimeToolUseExecutor
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance
> =>
  Effect.gen(function* () {
    // At-most-once external execution boundary. Building this Activity is what
    // pulls WorkflowEngine + WorkflowInstance into the requirements channel.
    const runTool = Activity.make({
      name: "proto.execute-tool",
      execute: RuntimeToolUseExecutor.pipe(
        Effect.flatMap((executor) => executor.execute(request)),
        Effect.orDie,
        Effect.asVoid,
      ),
    })
    yield* runTool
    return {
      _tag: "ToolResult" as const,
      toolUseId: request.toolUseId,
      output: undefined,
    }
  })
