import {
  RuntimeAgentToolExecution,
  RuntimeAgentToolExecutionLive,
  RuntimeToolUseExecutor,
} from "@firegrid/runtime/tool-executor"
import { RuntimeObservationStreams } from "@firegrid/runtime/streams"
import { Context, Effect, Layer } from "effect"
import { RuntimeChannelRouter } from "../../host/channel.ts"
import {
  HostRuntimeObservationStreamsLive,
  HostRuntimeObservationSubstrateLive,
} from "../../host/runtime-substrate.ts"
import {
  toolErrorResult,
  toolExecutionFailed,
} from "../bindings/tool-error.ts"
import { AgentToolHost } from "./tool-host.ts"
import { toolUseToEffect } from "./tool-use-to-effect.ts"

type RuntimeToolUseExecutorExecutionEnv =
  | AgentToolHost
  | RuntimeChannelRouter
  | RuntimeAgentToolExecution
  | RuntimeObservationStreams

// firegrid-host-sdk.TOOL_EXECUTOR_SEAM.2
// Host binding layer for the runtime-owned validated tool-use executor tag.
export const RuntimeToolUseExecutorLive = Layer.effect(
  RuntimeToolUseExecutor,
  Effect.gen(function* () {
    const captured = yield* Effect.context<RuntimeToolUseExecutorExecutionEnv>()
    const agentToolHost = Context.get(captured, AgentToolHost)
    const channelRouter = Context.get(captured, RuntimeChannelRouter)
    const toolExecution = Context.get(captured, RuntimeAgentToolExecution)
    const observationStreams = Context.get(captured, RuntimeObservationStreams)
    return RuntimeToolUseExecutor.of({
      execute: (context, event) =>
        toolUseToEffect(context, event).pipe(
          Effect.catchAllDefect(defect =>
            Effect.succeed(toolErrorResult(
              toolExecutionFailed(event.part.id, event.part.name, defect),
            ))),
          Effect.provideService(AgentToolHost, agentToolHost),
          Effect.provideService(RuntimeChannelRouter, channelRouter),
          Effect.provideService(RuntimeAgentToolExecution, toolExecution),
          Effect.provideService(RuntimeObservationStreams, observationStreams),
          Effect.tap(result =>
            Effect.annotateCurrentSpan({
              "firegrid.agent_output.tool_name": event.part.name,
              "firegrid.agent_output.tool_result_failure": result.part.isFailure,
            })),
          Effect.withSpan("firegrid.host.agent_tools.tool_use.execute", {
            kind: "internal",
            attributes: {
              "firegrid.context.id": context.contextId,
              "firegrid.agent_output.tool_name": event.part.name,
            },
          }),
          Effect.catchAllDefect(defect =>
            Effect.succeed(toolErrorResult(
              toolExecutionFailed(event.part.id, event.part.name, defect),
            ))),
        ),
    })
  }),
).pipe(
  Layer.withSpan("firegrid.host.agent_tools.tool_use_executor.layer", {
    kind: "internal",
  }),
)

// Wave D-A (PR #714) / Wave D-B (this PR): host-scope composition of the
// executor with its observation substrate + agent-tool-execution providers.
// Consumers (the Shape C subscriber bundle in `host/layers.ts`, the
// runtime-owned `ToolDispatchLive` facade installed alongside it) compose
// this Layer via `Layer.provideMerge`. Surfacing it here keeps the
// host-scope tool-executor wiring in the same file as the executor Live
// itself; the legacy `host/runtime-context-workflow-support.ts` file
// (which used to hold this factory alongside the now-deleted per-call
// `toolCallWorkflowSupportLayer` and per-context
// `runtimeContextWorkflowSupportLayer`) is deleted in this PR.
export const runtimeToolUseExecutorLayer = RuntimeToolUseExecutorLive.pipe(
  Layer.provide(HostRuntimeObservationSubstrateLive),
  Layer.provideMerge(HostRuntimeObservationStreamsLive),
  Layer.provideMerge(RuntimeAgentToolExecutionLive),
)
