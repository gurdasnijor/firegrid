import {
  recordLifecycleTerminalEvidence,
  RuntimeControlRequestSideEffects,
} from "@firegrid/runtime/control-plane"
import { Effect, Layer, type Scope } from "effect"
import type { AgentToolHost } from "../agent-tools/execution/tool-host.ts"
import type { RuntimeChannelRouter } from "./channel.ts"
import { startRuntime } from "./commands.ts"
import { PerContextRuntimeOutputWriter } from "./per-context-runtime-output.ts"
import { RuntimeContextWorkflowRuntime } from "./runtime-context-workflow-runtime.ts"
import type { HostRuntimeContextExecutionEnv } from "./runtime-substrate.ts"

// tf-bffo: the durable arm (RuntimeControlPlaneTable runs query/upsert + terminal
// output append) lives in @firegrid/runtime/control-plane. host-sdk composes the
// host arm: `start` spawns a child via startRuntime, `deregister` tears down the
// engine, and the durable arm is delegated to the runtime function with the
// host-resolved output writer.
export const RuntimeControlRequestSideEffectsLive = Layer.scoped(
  RuntimeControlRequestSideEffects,
  Effect.gen(function*() {
    const runtime = yield* RuntimeContextWorkflowRuntime
    const captured = yield* Effect.context<
      | AgentToolHost
      | RuntimeChannelRouter
      | HostRuntimeContextExecutionEnv
      | PerContextRuntimeOutputWriter
      | RuntimeContextWorkflowRuntime
      | Scope.Scope
    >()
    return RuntimeControlRequestSideEffects.of({
      start: request =>
        startRuntime({ contextId: request.contextId }).pipe(
          Effect.map(result => ({
            activityAttempt: result.activityAttempt,
            exitCode: result.exitCode,
            ...(result.signal === undefined ? {} : { signal: result.signal }),
          })),
          Effect.provide(captured),
        ),
      deregister: contextId => runtime.deregister(contextId),
      recordLifecycleTerminalEvidence: (context, request) =>
        Effect.flatMap(PerContextRuntimeOutputWriter, writer =>
          recordLifecycleTerminalEvidence(writer, context, request)).pipe(
          Effect.provide(captured),
        ),
    })
  }),
)
