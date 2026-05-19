import { Effect, Layer, Scope } from "effect"
import { WorkflowEngine } from "@effect/workflow"
import {
  RuntimeControlPlaneRecorderLive,
} from "@firegrid/runtime/control-plane"
import {
  type DurableWaitCompletionRowLookup,
  type DurableWaitCompletionRowUpsert,
  type DurableWaitRowLookup,
  type DurableWaitRowUpsert,
} from "@firegrid/runtime/durable-tools"
import {
  type CurrentHostSession,
  type RuntimeControlPlaneTable,
  type RuntimeOutputTable,
} from "@firegrid/protocol/launch"
import { type RuntimeHostConfig } from "./config.ts"
import {
  RuntimeAgentOutputEventsLayer,
} from "@firegrid/runtime/runtime-output"
import { RuntimeToolUseExecutor } from "@firegrid/runtime/tool-executor"
import {
  toolUseToEffect,
} from "../agent-tools/execution/tool-use-to-effect.ts"
import {
  toolErrorResult,
  toolExecutionFailed,
} from "../agent-tools/bindings/tool-error.ts"
import { type AgentToolHost } from "../agent-tools/execution/tool-host.ts"
import { HostOwnedDurableToolsWaitForLive } from "./host-owned-durable-tools.ts"
import {
  PerContextRuntimeAgentOutputAfterEventsLive,
} from "./per-context-runtime-output.ts"

type RuntimeToolUseExecutorHostEnvironment =
  | DurableWaitRowLookup
  | DurableWaitRowUpsert
  | DurableWaitCompletionRowLookup
  | DurableWaitCompletionRowUpsert
  | AgentToolHost

// LENS: host-sdk:captured-context-relay — whole-context capture+re-provide is a deliberate bulk relay; canonical of 5 (see LENSES.md)
// TFIND-031: the host-provided durable substrate that a per-context
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
  | CurrentHostSession
  | RuntimeHostConfig

// TFIND-031 (Option Y, execution-scoped): the workflow-body capture
// seam (`RuntimeContextWorkflowNativeLayer`) is built *inside*
// `runtimeContextWorkflowSupportLayer`, where `HostRuntimeObservationSubstrateLive`
// already provides the durable-wait substrate execution-scoped (one
// shared materialized store — see SDD shared-store proof). So that seam
// alone may capture the wider set including `DurableWait*`; the host-
// level seams (commands / agent-tool-host) must NOT — those tags are
// deliberately not ambient on the public `FiregridRuntimeHostWithWorkflowLive`.
export type RuntimeContextWorkflowExecutionEnv =
  | HostRuntimeContextExecutionEnv
  | DurableWaitRowLookup
  | DurableWaitRowUpsert
  | DurableWaitCompletionRowLookup
  | DurableWaitCompletionRowUpsert

// firegrid-runtime-boundary-reconciliation.HOST_HARDENING.2
// firegrid-typed-wait-source-redesign.WAIT_ROUTER.1
// firegrid-typed-wait-source-redesign.REJECTION.2
// Shared host runtime observation substrate used by workflow support layers.
// The durable-tools wait router consumes the typed observation tags directly
// and requires the current WorkflowEngine so matched observations can wake
// suspended workflow deferreds; there is no source-name registration layer.
export const HostRuntimeObservationSubstrateLive = HostOwnedDurableToolsWaitForLive.pipe(
  Layer.provideMerge(Layer.mergeAll(
    RuntimeAgentOutputEventsLayer,
    PerContextRuntimeAgentOutputAfterEventsLive,
    RuntimeControlPlaneRecorderLive,
  )),
)

// firegrid-host-sdk.TOOL_EXECUTOR_SEAM.2
// Temporary runtime-host live layer. The future host-sdk layer can provide the
// same runtime-owned tag after the agent-tool bindings move out of runtime.
export const RuntimeToolUseExecutorLive = Layer.effect(
  RuntimeToolUseExecutor,
  Effect.gen(function* () {
    const captured = yield* Effect.context<RuntimeToolUseExecutorHostEnvironment>()
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
          Effect.catchAllDefect(defect =>
            Effect.succeed(toolErrorResult(
              toolExecutionFailed(event.part.id, event.part.name, defect),
            ))),
        ),
    })
  }),
)
