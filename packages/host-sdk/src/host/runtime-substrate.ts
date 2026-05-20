import { Effect, Layer, Scope } from "effect"
import { WorkflowEngine } from "@effect/workflow"
import {
  RuntimeControlPlaneRecorderLive,
} from "@firegrid/runtime/control-plane"
import {
  type CurrentHostSession,
  type RuntimeControlPlaneTable,
  type RuntimeOutputTable,
} from "@firegrid/protocol/launch"
import { type RuntimeHostConfig } from "./config.ts"
import {
  type RuntimeAgentOutputAfterEvents,
  RuntimeAgentOutputEventsLayer,
} from "@firegrid/runtime/runtime-output"
import {
  RuntimeObservationStreamsLive,
  type RuntimeObservationStreams,
} from "@firegrid/runtime/streams"
import {
  makeRuntimeAgentToolExecutionService,
  RuntimeAgentToolExecution,
  RuntimeToolUseExecutor,
} from "@firegrid/runtime/tool-executor"
import {
  toolUseToEffect,
} from "../agent-tools/execution/tool-use-to-effect.ts"
import type { ChannelInventory } from "./channel.ts"
import {
  toolErrorResult,
  toolExecutionFailed,
} from "../agent-tools/bindings/tool-error.ts"
import { type AgentToolHost } from "../agent-tools/execution/tool-host.ts"
import {
  HostOwnedDurableToolsWaitForLive,
  type HostOwnedRuntimeObservationSubstrate,
} from "./host-owned-durable-tools.ts"
import {
  PerContextRuntimeAgentOutputAfterEventsLive,
} from "./per-context-runtime-output.ts"

// TFIND-031: the host-provided runtime context that a per-context
// workflow execution genuinely requires. Deferred-execution seams
// (`Effect.context<…>()` captured at Layer-build time and re-provided
// into closures that run later) MUST capture this set instead of
// `never`. These tags are always satisfied at runtime by the composed
// Firegrid host layer (`FiregridRuntimeHostLive`); annotating `never`
// was only ever sound because `DurableTable.layer` leaked `any` and
// collapsed the requirements channel. With precise `.layer` typing the
// real requirement surfaces — declare it honestly here rather than
// re-erase it.
export type HostRuntimeContextExecutionEnv =
  | RuntimeControlPlaneTable
  | RuntimeOutputTable
  | RuntimeAgentOutputAfterEvents
  | CurrentHostSession
  | RuntimeHostConfig

// firegrid-runtime-boundary-reconciliation.HOST_HARDENING.2
// firegrid-typed-wait-source-redesign.WAIT_ROUTER.1
// firegrid-typed-wait-source-redesign.REJECTION.2
// Shared host runtime observation substrate used by workflow support layers.
// The current wait router consumes the typed observation tags directly
// and requires the current WorkflowEngine so matched observations can wake
// suspended workflow deferreds; there is no source-name registration layer.
export const HostRuntimeObservationSubstrateLive = HostOwnedDurableToolsWaitForLive.pipe(
  Layer.provideMerge(RuntimeAgentOutputEventsLayer),
  Layer.provideMerge(PerContextRuntimeAgentOutputAfterEventsLive),
  Layer.provideMerge(RuntimeControlPlaneRecorderLive),
  Layer.withSpan("firegrid.host.runtime_substrate.observation.layer", {
    kind: "internal",
  }),
)

type HostRuntimeObservationSubstrateEnv = HostOwnedRuntimeObservationSubstrate

export const HostRuntimeObservationStreamsLive = RuntimeObservationStreamsLive.pipe(
  Layer.provideMerge(HostRuntimeObservationSubstrateLive),
  Layer.withSpan("firegrid.host.runtime_substrate.observation_streams.layer", {
    kind: "internal",
  }),
)

// TFIND-031 (Option Y, execution-scoped): the workflow-body capture
// seam (`RuntimeContextWorkflowNativeLayer`) is built *inside*
// `runtimeContextWorkflowSupportLayer`, where
// `HostRuntimeObservationSubstrateLive` self-contains the observation
// substrate. Host-level seams (commands / agent-tool-host) capture only
// the public host runtime context; wait-store services are not ambient on
// `FiregridRuntimeHostWithWorkflowLive`.
export type RuntimeContextWorkflowExecutionEnv =
  | HostRuntimeContextExecutionEnv
  | HostRuntimeObservationSubstrateEnv

type RuntimeToolUseExecutorExecutionEnv =
  | HostRuntimeObservationSubstrateEnv
  | AgentToolHost
  | ChannelInventory
  | RuntimeAgentToolExecution
  | RuntimeObservationStreams

// firegrid-host-sdk.PACKAGE_GRAPH.6
// Host-provided live layer for the runtime-owned validated tool execution seam.
export const RuntimeAgentToolExecutionLive = RuntimeAgentToolExecution.layer(
  makeRuntimeAgentToolExecutionService(),
).pipe(
  Layer.withSpan("firegrid.host.runtime_substrate.agent_tool_execution.layer", {
    kind: "internal",
  }),
)

// firegrid-host-sdk.TOOL_EXECUTOR_SEAM.2
// Temporary runtime-host live layer. The future host-sdk layer can provide the
// same runtime-owned tag after the agent-tool bindings move out of runtime.
export const RuntimeToolUseExecutorLive = Layer.effect(
  RuntimeToolUseExecutor,
  Effect.gen(function* () {
    const captured = yield* Effect.context<RuntimeToolUseExecutorExecutionEnv>()
    return RuntimeToolUseExecutor.of({
      execute: (context, event) =>
        Effect.gen(function*() {
          const currentEngine = yield* WorkflowEngine.WorkflowEngine
          const currentInstance = yield* WorkflowEngine.WorkflowInstance
          const currentScope = yield* Effect.scope
          return yield* toolUseToEffect(context, event).pipe(
            Effect.catchAllDefect(defect =>
              Effect.succeed(toolErrorResult(
                toolExecutionFailed(event.part.id, event.part.name, defect),
              ))),
            Effect.provide(captured),
            Effect.provideService(WorkflowEngine.WorkflowEngine, currentEngine),
            Effect.provideService(WorkflowEngine.WorkflowInstance, currentInstance),
            Effect.provideService(Scope.Scope, currentScope),
          )
        }).pipe(
          Effect.tap(result =>
            Effect.annotateCurrentSpan({
              "firegrid.agent_output.tool_name": event.part.name,
              "firegrid.agent_output.tool_result_failure": result.part.isFailure,
            })),
          Effect.withSpan("firegrid.host.runtime_substrate.tool_use.execute", {
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
  Layer.withSpan("firegrid.host.runtime_substrate.tool_use_executor.layer", {
    kind: "internal",
  }),
)
