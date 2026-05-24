import { RuntimeControlPlaneTable } from "@firegrid/protocol/launch"
import {
  recordLifecycleTerminalEvidence,
  RuntimeContextRead,
  RuntimeControlRequestSideEffects,
  RuntimeRunAppendAndGet,
  type RuntimeControlRequestStartResult,
} from "../../control-plane/index.ts"
import { RuntimeContextWorkflowSession } from "../runtime-context-session/handler.ts"
import { RuntimeContextSessionWorkflowDispatch } from "../runtime-context-session-workflow/index.ts"
import { asRuntimeContextError } from "../../runtime-errors.ts"
import { Effect, Layer, Option, type Scope } from "effect"
import { PerContextRuntimeOutputWriter } from "../../producers/ingress-writers/per-context-output.ts"

// Wave D-A Shape (b) cutover (PR #714):
//
//   start      — `allocateActivityAttempt` -> `recordStarted` ->
//                `RuntimeContextWorkflowSession.startOrAttach` ->
//                `RuntimeRunAppendAndGet.waitTerminal(contextId, attempt)`
//                (the typed authority surface that wraps the durable
//                runs.rows() Stream.runHead). The Shape C subscriber is
//                the sole production writer of the terminal row, via
//                `recordExited` on Terminated transition or
//                `recordFailed` on startOrAttach failure (handled below).
//   deregister — `RuntimeContextWorkflowSession.deregister(contextId)` via
//                the seam extension that replaces the retired kernel
//                runtime wrapper's deregister method. No
//                `@firegrid/runtime/kernel` import remains on this file.
//
// All errors are typed `RuntimeContextError` (via `asRuntimeContextError`)
// matching `host/commands.ts`'s diagnostic shape — no raw `new Error(...)`
// reaches the typed seam.
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
      | PerContextRuntimeOutputWriter
      | RuntimeContextRead
      | RuntimeContextWorkflowSession
      | RuntimeContextSessionWorkflowDispatch
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

// Per-request side-effect body. The Shape C subscriber writes the
// terminal `runs.exited|failed` row when it observes Terminated; this
// function waits on that row via the typed authority surface
// `RuntimeRunAppendAndGet.waitTerminal`. Errors are typed
// `RuntimeContextError`; `runStartRequestSideEffect`'s `Effect.tapError`
// at `control-request-dispatcher.ts:395-405` converts the typed cause
// into a failed completion row.
const startRuntimeContext = (
  contextId: string,
): Effect.Effect<
  RuntimeControlRequestStartResult,
  unknown,
  | RuntimeContextRead
  | RuntimeContextSessionWorkflowDispatch
  | RuntimeRunAppendAndGet
> =>
  Effect.gen(function*() {
    const contextRead = yield* RuntimeContextRead
    const contextOpt = yield* contextRead.readContext(contextId)
    if (Option.isNone(contextOpt)) {
      return yield* asRuntimeContextError(
        "host.runtime_context.side_effect.start.context_not_found",
        `runtime context ${contextId} not found in control plane`,
        contextId,
      )
    }
    const context = contextOpt.value
    const runs = yield* RuntimeRunAppendAndGet
    const attempt = yield* runs.allocateActivityAttempt(context)
    yield* runs.recordStarted(context, attempt)
    // PR #738 Zed agent_silent fix: dispatch RuntimeContextSessionWorkflow
    // INSTEAD of calling session.startOrAttach directly. The workflow is the
    // sole admission boundary for `(contextId, attempt)`; its
    // `idempotencyKey: contextId:attempt` collapses any concurrent
    // dispatches; its body is the only call site for the codec's underlying
    // startOrAttach (Activity-memoized → exactly-once). The pre-cutover
    // direct `session.startOrAttach` here raced with the Shape C subscriber's
    // implicit `getOrStart → startOrAttach` chain and spawned 2 agent
    // processes on the same `(contextId, attempt)`.
    //
    // We dispatch fire-and-forget (the workflow body runs as long as the
    // session is alive); termination is observed via `runs.waitTerminal`
    // below — the Shape C subscriber writes `runs.exited|failed` on
    // Terminated output transition, same as pre-cutover.
    const sessionWorkflow = yield* RuntimeContextSessionWorkflowDispatch
    yield* sessionWorkflow.dispatch({ contextId: context.contextId, activityAttempt: attempt }).pipe(
      Effect.tapError((cause) =>
        runs.recordFailed(
          context,
          attempt,
          cause instanceof Error ? cause.message : String(cause),
        )),
      Effect.fork,
    )
    const terminalOpt = yield* runs.waitTerminal(contextId, attempt)
    if (Option.isNone(terminalOpt)) {
      return yield* asRuntimeContextError(
        "host.runtime_context.side_effect.start.runs_stream_ended",
        `runs.rows stream ended before a terminal row arrived for ${contextId}@${attempt}`,
        contextId,
      )
    }
    const terminal = terminalOpt.value
    if (terminal.status === "failed") {
      return yield* asRuntimeContextError(
        "host.runtime_context.side_effect.start.runs_failed",
        terminal.message ?? "runtime context terminated with failure status",
        contextId,
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
