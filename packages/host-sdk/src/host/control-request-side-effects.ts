import {
  RuntimeControlPlaneTable,
  type RuntimeContext,
  type RuntimeLifecycleRequestRow,
} from "@firegrid/protocol/launch"
import {
  RuntimeControlRequestSideEffects,
} from "@firegrid/runtime/control-plane"
import { Effect, Layer, Option, type Scope } from "effect"
import type { AgentToolHost } from "../agent-tools/execution/tool-host.ts"
import type { ChannelInventory } from "./channel.ts"
import { startRuntime } from "./commands.ts"
import { PerContextRuntimeOutputWriter } from "./per-context-runtime-output.ts"
import { RuntimeContextWorkflowRuntime } from "./runtime-context-workflow-runtime.ts"
import type { HostRuntimeContextExecutionEnv } from "./runtime-substrate.ts"

const activeActivityAttempt = (
  contextId: string,
): Effect.Effect<Option.Option<number>, unknown, RuntimeControlPlaneTable> =>
  Effect.gen(function*() {
    const table = yield* RuntimeControlPlaneTable
    return yield* table.runs.query((coll) => {
      const rows = coll.toArray.filter(row => row.contextId === contextId)
      const terminalAttempts = new Set(
        rows
          .filter(row => row.status === "exited" || row.status === "failed")
          .map(row => row.activityAttempt),
      )
      const started = rows
        .filter(row => row.status === "started" && !terminalAttempts.has(row.activityAttempt))
        .map(row => row.activityAttempt)
        .sort((left, right) => right - left)[0]
      return Option.fromNullable(started)
    })
  })

const recordLifecycleTerminalEvidence = (
  context: RuntimeContext,
  request: RuntimeLifecycleRequestRow,
): Effect.Effect<
  void,
  unknown,
  RuntimeControlPlaneTable | PerContextRuntimeOutputWriter
> =>
  Effect.gen(function*() {
    const attempt = yield* activeActivityAttempt(request.contextId)
    if (Option.isNone(attempt)) return
    const exitCode = request.lifecycle === "cancel" ? 130 : 0
    const table = yield* RuntimeControlPlaneTable
    yield* table.runs.upsert({
      runEventId: {
        contextId: request.contextId,
        activityAttempt: attempt.value,
        status: "exited",
      },
      contextId: request.contextId,
      activityAttempt: attempt.value,
      provider: context.runtime.provider,
      status: "exited",
      at: new Date().toISOString(),
      exitCode,
      ...(request.lifecycle === "cancel" ? { signal: "SIGTERM" } : {}),
    })
    const writer = yield* PerContextRuntimeOutputWriter
    yield* writer.appendAgentEvent(context, attempt.value, Number.MAX_SAFE_INTEGER, {
      _tag: "Terminated",
      exitCode,
    })
  }).pipe(
    Effect.withSpan("firegrid.host.control_request.lifecycle.terminal_evidence", {
      kind: "producer",
      attributes: {
        "firegrid.context.id": request.contextId,
        "firegrid.control.request_id": request.requestId,
        "firegrid.control.lifecycle": request.lifecycle,
      },
    }),
  )

export const RuntimeControlRequestSideEffectsLive = Layer.effect(
  RuntimeControlRequestSideEffects,
  Effect.gen(function*() {
    const runtime = yield* RuntimeContextWorkflowRuntime
    const captured = yield* Effect.context<
      | AgentToolHost
      | ChannelInventory
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
        recordLifecycleTerminalEvidence(context, request).pipe(
          Effect.provide(captured),
        ),
    })
  }),
)
