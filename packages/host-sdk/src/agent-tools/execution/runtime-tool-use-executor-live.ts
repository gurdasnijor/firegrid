import {
  RuntimeAgentToolExecution,
  RuntimeToolUseExecutor,
} from "@firegrid/runtime/tool-executor"
import { RuntimeObservationStreams } from "@firegrid/runtime/streams"
import { Context, Effect, Layer } from "effect"
import { RuntimeChannelRouter } from "../../host/channel.ts"
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
