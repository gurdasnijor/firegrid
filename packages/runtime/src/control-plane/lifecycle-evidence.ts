import {
  RuntimeControlPlaneTable,
  type RuntimeContext,
  type RuntimeLifecycleRequestRow,
} from "@firegrid/protocol/launch"
import { Effect, Option } from "effect"
import type { PerContextRuntimeOutputWriterService } from "../tables/per-context-output.ts"

// tf-bffo: the durable control-request lifecycle evidence (RuntimeControlPlaneTable
// runs query/upsert + the terminal output append) is kernel-internal durable-state
// behavior. It lives in the runtime; host-sdk's RuntimeControlRequestSideEffects
// composition delegates to these functions for the durable arm, while the host arm
// (spawning the child via startRuntime, deregistering the engine) stays in host-sdk.

export const activeActivityAttempt = (
  contextId: string,
): Effect.Effect<Option.Option<number>, unknown, RuntimeControlPlaneTable> =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- DurableTable query still leaks `any` in the requirement channel; the declared Effect type is the intended durable capability boundary.
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

export const recordLifecycleTerminalEvidence = (
  writer: PerContextRuntimeOutputWriterService,
  context: RuntimeContext,
  request: RuntimeLifecycleRequestRow,
): Effect.Effect<void, unknown, RuntimeControlPlaneTable> =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- DurableTable writes still leak `any` in the requirement channel; the declared Effect type is the intended durable capability boundary.
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
