import {
  recordLifecycleTerminalEvidence,
  RuntimeContextRead,
  RuntimeControlRequestSideEffects,
  RuntimeRunAppendAndGet,
  type RuntimeControlRequestStartResult,
} from "@firegrid/runtime/control-plane"
import { RuntimeContextWorkflowSession } from "@firegrid/runtime/subscribers/runtime-context-session"
import { RuntimeControlPlaneTable } from "@firegrid/protocol/launch"
import { Effect, Layer, Option, Stream, type Scope } from "effect"
import type { AgentToolHost } from "../agent-tools/execution/tool-host.ts"
import type { RuntimeChannelRouter } from "./channel.ts"
import { PerContextRuntimeOutputWriter } from "./per-context-runtime-output.ts"
import type { HostRuntimeContextExecutionEnv } from "./runtime-substrate.ts"

// Wave D-A Shape (b) cutover (PR #714):
//
//   start      — `allocateActivityAttempt` -> `recordStarted` ->
//                `RuntimeContextWorkflowSession.startOrAttach` ->
//                wait for the durable `runs.exited|failed` row the Shape C
//                subscriber writes when it observes Terminated
//                (`subscribers/runtime-context/handler.ts`).
//   deregister — `RuntimeContextWorkflowSession.deregister(contextId)` via
//                the seam extension that replaces the retired
//                `RuntimeContextWorkflowRuntime.deregister`. No
//                `@firegrid/runtime/kernel` import remains on this file
//                after the cutover; the legacy body-driver primitive
//                `host/internal/runtime-context-host-start.ts` deletes
//                with this commit.
//
// Wave C non-recursive boundary split (#706) carries forward: the
// reconciler-side `SideEffects.start` writes the durable rows that the
// public `startRuntime` facade observes via `SessionLifecycleChannel`
// (#708). Calling the public facade from here would re-enter the same
// request row the reconciler is consuming.
export const RuntimeControlRequestSideEffectsLive = Layer.scoped(
  RuntimeControlRequestSideEffects,
  Effect.gen(function*() {
    const captured = yield* Effect.context<
      | AgentToolHost
      | RuntimeChannelRouter
      | HostRuntimeContextExecutionEnv
      | PerContextRuntimeOutputWriter
      | RuntimeContextRead
      | RuntimeContextWorkflowSession
      | RuntimeControlPlaneTable
      | RuntimeRunAppendAndGet
      | Scope.Scope
    >()
    return RuntimeControlRequestSideEffects.of({
      start: request =>
        startRuntimeContext(request.contextId).pipe(Effect.provide(captured)),
      deregister: contextId =>
        Effect.flatMap(RuntimeContextWorkflowSession, (session) =>
          session.deregister(contextId)).pipe(Effect.provide(captured)),
      recordLifecycleTerminalEvidence: (context, request) =>
        Effect.flatMap(PerContextRuntimeOutputWriter, writer =>
          recordLifecycleTerminalEvidence(writer, context, request)).pipe(
          Effect.provide(captured),
        ),
    })
  }),
)

// Per-request side-effect body. The subscriber writes the terminal
// `runs.exited|failed` row when it observes Terminated; this body waits on
// that row via a bounded stream subscription. Soft-fail of the lookup
// stages (context not found, etc.) propagate through the typed error
// channel so the caller's `Effect.tapError` writes a `status:"failed"`
// completion row (cf. `control-request-dispatcher.ts:395-405`).
const startRuntimeContext = (
  contextId: string,
): Effect.Effect<
  RuntimeControlRequestStartResult,
  unknown,
  | RuntimeContextRead
  | RuntimeContextWorkflowSession
  | RuntimeControlPlaneTable
  | RuntimeRunAppendAndGet
> =>
  Effect.gen(function*() {
    const contextRead = yield* RuntimeContextRead
    const contextOpt = yield* contextRead.readContext(contextId)
    if (Option.isNone(contextOpt)) {
      return yield* Effect.fail(
        new Error(`runtime context ${contextId} not found in control plane`),
      )
    }
    const context = contextOpt.value
    const runs = yield* RuntimeRunAppendAndGet
    const attempt = yield* runs.allocateActivityAttempt(context)
    yield* runs.recordStarted(context, attempt)
    const session = yield* RuntimeContextWorkflowSession
    // Wave D-A: if `startOrAttach` fails (e.g. sandbox.openBytePipe could
    // not spawn the agent), write `runs.failed` before propagating so the
    // durable run lifecycle row chain matches the legacy body's
    // failure-path contract (cf. workflow-engine/workflows/runtime-context-
    // run.ts:117-118 `writeRunFailed`). Without this, the runs.status
    // chain stays at [started] forever and no terminal evidence reaches
    // the completion row.
    yield* session.startOrAttach(context, attempt).pipe(
      Effect.tapError((cause) =>
        runs.recordFailed(
          context,
          attempt,
          cause instanceof Error ? cause.message : String(cause),
        )),
    )
    const control = yield* RuntimeControlPlaneTable
    const terminalOpt = yield* control.runs.rows().pipe(
      Stream.filter((row) =>
        row.contextId === contextId &&
        row.activityAttempt === attempt &&
        (row.status === "exited" || row.status === "failed")),
      Stream.runHead,
    )
    if (Option.isNone(terminalOpt)) {
      return yield* Effect.fail(
        new Error(
          `runs.rows stream ended before a terminal row arrived for ${contextId}@${attempt}`,
        ),
      )
    }
    const terminal = terminalOpt.value
    if (terminal.status === "failed") {
      return yield* Effect.fail(
        new Error(terminal.message ?? "runtime context terminated with failure status"),
      )
    }
    return {
      activityAttempt: attempt,
      exitCode: terminal.exitCode ?? 0,
      ...(terminal.signal === undefined ? {} : { signal: terminal.signal }),
    }
  }).pipe(
    Effect.withSpan("firegrid.host.runtime_context.side_effect.start", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": contextId,
      },
    }),
    Effect.annotateSpans("firegrid.side", "host"),
  )
