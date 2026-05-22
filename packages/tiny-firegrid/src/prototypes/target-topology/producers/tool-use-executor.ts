// producers/ — the live side-effecting tool executor.
//
// C3: a tool result is a durable completion keyed by `toolUseId`; the executor
// is the claimed-work operator that replays to a live boundary and runs the
// external effect at most once. The Shape D tool-call subscriber names this tag
// AND `WorkflowEngine` in `R`; the executor itself is the live capability.

import { Context, Effect, Layer } from "effect"
import type { ToolResultEvent } from "../events/index.ts"
import type { ProtoRuntimeError } from "../errors.ts"

export interface ToolUseRequest {
  readonly contextId: string
  readonly toolUseId: string
  readonly toolName: string
  readonly input: unknown
}

export interface RuntimeToolUseExecutorService {
  readonly execute: (
    request: ToolUseRequest,
  ) => Effect.Effect<ToolResultEvent, ProtoRuntimeError>
}

export class RuntimeToolUseExecutor extends Context.Tag(
  "@proto/target-topology/RuntimeToolUseExecutor",
)<RuntimeToolUseExecutor, RuntimeToolUseExecutorService>() {}

export const RuntimeToolUseExecutorStubLayer: Layer.Layer<RuntimeToolUseExecutor> =
  Layer.succeed(RuntimeToolUseExecutor, {
    execute: (request) =>
      Effect.succeed({
        _tag: "ToolResult" as const,
        toolUseId: request.toolUseId,
        output: undefined,
      }),
  })
