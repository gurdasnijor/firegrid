import {
  CurrentHostSession,
  RuntimeControlPlaneTable,
  makeLocalRuntimeContextForHostSession,
  makeRuntimeControlRequestCompletionRow,
  normalizeRuntimeIntent,
  RuntimeControlRequestCompletionRowSchema,
  type RuntimeContextRequestRow,
  type RuntimeControlRequestCompletionRow,
  type RuntimeControlRequestKind,
  type RuntimeContext,
  type RuntimeLifecycleRequestRow,
  type RuntimeOutputTable,
  type RuntimeStartRequestRow,
} from "@firegrid/protocol/launch"
import { Activity, WorkflowEngine } from "@effect/workflow"
import { DurableStreamsWorkflowEngine } from "@firegrid/runtime/workflow-engine"
import {
  RuntimeContextProvisionWorkflow,
  RuntimeLifecycleWorkflow,
  RuntimeStartWorkflow,
  runtimeControlRequestWorkflowExecutionId,
  runtimeControlRequestWorkflowStreamUrl,
  type RuntimeControlRequestDispatchOutcome,
} from "@firegrid/runtime/workflows"
import { Cause, Clock, Context, Duration, Effect, Layer, Option, Stream, type Scope } from "effect"
import { withRowOtelParent } from "@firegrid/protocol/otel"
import type { AgentToolHost } from "../agent-tools/execution/tool-host.ts"
import { startRuntime } from "./commands.ts"
import { RuntimeContextWorkflowRuntime } from "./runtime-context-workflow-runtime.ts"
import type { HostRuntimeContextExecutionEnv } from "./runtime-substrate.ts"
import { PerContextRuntimeOutputWriter } from "./per-context-runtime-output.ts"
import { RuntimeHostConfig } from "./config.ts"
import type { ChannelRegistry } from "./channel-registry.ts"

const runtimeControlPlaneTable: Effect.Effect<
  RuntimeControlPlaneTable["Type"],
  never,
  RuntimeControlPlaneTable
> = RuntimeControlPlaneTable

const currentHostSession: Effect.Effect<
  CurrentHostSession["Type"],
  never,
  CurrentHostSession
> = CurrentHostSession

export const runtimeControlRequestReconcilerDefaults = {
  pollIntervalMs: 5_000,
  abandonAfterMs: 600_000,
  startRequestExecution: "await" as const,
} as const

type StartRequestExecution = "await" | "background"

export interface RuntimeControlRequestReconcilerOptions {
  readonly pollIntervalMs?: number
  /**
   * @deprecated Control request ownership moved to workflow Activity claims.
   * This remains accepted so older callers do not break while the public
   * request-row compatibility surface settles.
   */
  readonly claimWindowMs?: number
  /**
   * @deprecated Request dispatch now starts workflow executions; execution
   * concurrency is owned by DurableStreamsWorkflowEngine.
   */
  readonly startRequestConcurrency?: number | "unbounded"
  readonly abandonAfterMs?: number
  readonly startRequestExecution?: StartRequestExecution
}

type ResolvedRuntimeControlRequestReconcilerOptions = {
  readonly abandonAfterMs: number
  readonly startRequestExecution: StartRequestExecution
}

// TFIND-045: `reconcileStartRequest` calls `startRuntime()`, which
// transitively requires `RuntimeOutputTable` and
// `HostRuntimeContextExecutionEnv` via RuntimeContextWorkflowRuntime.
// Before TFIND-005's curry, `RuntimeOutputTable`'s tag identity was
// `any`, so it was mutually assignable with `RuntimeControlPlaneTable`
// (Crux-B false equivalence) and these two were silently discharged —
// a genuine missing-dependency the `any` masked. They are enumerated
// explicitly here so the declared environment matches the real
// transitive requirement. Planned reconciliation (NOT a new finding):
// once TFIND-029 (#328) makes `RuntimeStartCapabilityLive`'s
// workflow-support deps explicit/self-contained, this enumeration may
// tighten — see docs/sdds/SDD_RECONCILER_ENV_ENUMERATION.md §5 Q4.
type RuntimeControlRequestReconcilerEnvironment =
  | CurrentHostSession
  | RuntimeControlPlaneTable
  | RuntimeContextWorkflowRuntime
  | ChannelRegistry
  | PerContextRuntimeOutputWriter
  | AgentToolHost
  | RuntimeOutputTable
  | HostRuntimeContextExecutionEnv
  | RuntimeControlRequestWorkflowEngine
  | Scope.Scope

export interface RuntimeControlRequestReconcilerService {
  readonly reconcileOnce: (
    options?: RuntimeControlRequestReconcilerOptions,
  ) => Effect.Effect<void, unknown, RuntimeControlRequestReconcilerEnvironment>
  readonly run: (
    options?: RuntimeControlRequestReconcilerOptions,
  ) => Effect.Effect<never, never, RuntimeControlRequestReconcilerEnvironment>
}

export class RuntimeControlRequestReconciler extends Context.Tag(
  "@firegrid/host/RuntimeControlRequestReconciler",
)<RuntimeControlRequestReconciler, RuntimeControlRequestReconcilerService>() {}

const optionValue = (
  value: number | undefined,
  fallback: number,
): number => value ?? fallback

const resolveOptions = (
  options: RuntimeControlRequestReconcilerOptions,
): ResolvedRuntimeControlRequestReconcilerOptions => ({
  abandonAfterMs: optionValue(
    options.abandonAfterMs,
    runtimeControlRequestReconcilerDefaults.abandonAfterMs,
  ),
  startRequestExecution: options.startRequestExecution ??
    runtimeControlRequestReconcilerDefaults.startRequestExecution,
})

const createdAtMs = (createdAt: string): number => {
  const parsed = Date.parse(createdAt)
  return Number.isFinite(parsed) ? parsed : 0
}

const requestTimedOut = (
  requestCreatedAt: string,
  nowMs: number,
  abandonAfterMs: number,
): boolean => nowMs - createdAtMs(requestCreatedAt) >= abandonAfterMs

type ReconcileOutcome = "noop" | "claimed" | "advanced" | "completed" | "errored"

const annotateReconcileOutcome = (outcome: ReconcileOutcome) =>
  Effect.annotateCurrentSpan({
    "firegrid.control.reconcile.outcome": outcome,
  })

type ControlRequest =
  | RuntimeContextRequestRow
  | RuntimeStartRequestRow
  | RuntimeLifecycleRequestRow

const hasTerminal = (
  completion: Option.Option<RuntimeControlRequestCompletionRow>,
): boolean => Option.isSome(completion)

const writeCompletion = (
  requestKind: RuntimeControlRequestKind,
  request: ControlRequest,
  input: {
    readonly status: RuntimeControlRequestCompletionRow["status"]
    readonly hostId: string
    readonly completedAtMs: number
    readonly activityAttempt?: number
    readonly exitCode?: number
    readonly signal?: string
    readonly message?: string
  },
): Effect.Effect<RuntimeControlRequestCompletionRow, unknown, RuntimeControlPlaneTable> =>
  Effect.gen(function*() {
    const table = yield* runtimeControlPlaneTable
    const row = makeRuntimeControlRequestCompletionRow({
      ...input,
      requestKind,
      requestId: request.requestId,
      contextId: request.contextId,
    })
    const result = yield* table.controlRequestCompletions.insertOrGet(row)
    return result._tag === "Found" ? result.row : row
  }).pipe(
    Effect.withSpan("firegrid.host.control_request.completion.write", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": request.contextId,
        "firegrid.control.request_id": request.requestId,
        "firegrid.control.request_kind": requestKind,
        "firegrid.control.completion_status": input.status,
      },
    }),
  )

const abandon = (
  requestKind: RuntimeControlRequestKind,
  request: ControlRequest,
  nowMs: number,
  abandonAfterMs: number,
): Effect.Effect<RuntimeControlRequestCompletionRow, unknown, CurrentHostSession | RuntimeControlPlaneTable> =>
  Effect.gen(function*() {
    const session = yield* currentHostSession
    return yield* writeCompletion(requestKind, request, {
      status: "abandoned",
      hostId: session.hostId,
      completedAtMs: nowMs,
      message: `request abandoned after ${abandonAfterMs}ms`,
    })
  }).pipe(
    Effect.withSpan("firegrid.host.control_request.abandon", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": request.contextId,
        "firegrid.control.request_id": request.requestId,
        "firegrid.control.request_kind": requestKind,
        "firegrid.control.abandon_after_ms": abandonAfterMs,
      },
    }),
  )

type RuntimeControlRequestWorkflowExecutionEnv =
  | CurrentHostSession
  | RuntimeControlPlaneTable
  | RuntimeContextWorkflowRuntime
  | ChannelRegistry
  | PerContextRuntimeOutputWriter
  | AgentToolHost
  | RuntimeOutputTable
  | HostRuntimeContextExecutionEnv

interface RuntimeControlRequestWorkflowEngineService {
  readonly contextProvision: (
    request: RuntimeContextRequestRow,
    options: ResolvedRuntimeControlRequestReconcilerOptions,
  ) => Effect.Effect<void, unknown, Scope.Scope>
  readonly start: (
    request: RuntimeStartRequestRow,
    options: ResolvedRuntimeControlRequestReconcilerOptions,
  ) => Effect.Effect<void, unknown, Scope.Scope>
  readonly lifecycle: (
    request: RuntimeLifecycleRequestRow,
    options: ResolvedRuntimeControlRequestReconcilerOptions,
  ) => Effect.Effect<void, unknown, Scope.Scope>
}

export class RuntimeControlRequestWorkflowEngine extends Context.Tag(
  "@firegrid/host-sdk/RuntimeControlRequestWorkflowEngine",
)<RuntimeControlRequestWorkflowEngine, RuntimeControlRequestWorkflowEngineService>() {}

const terminalOrAbandonedCompletion = (
  requestKind: RuntimeControlRequestKind,
  request: ControlRequest,
  abandonAfterMs: number,
): Effect.Effect<Option.Option<RuntimeControlRequestCompletionRow>, unknown, CurrentHostSession | RuntimeControlPlaneTable> =>
  Effect.gen(function*() {
    const table = yield* runtimeControlPlaneTable
    const terminal = yield* table.controlRequestCompletions.get(request.requestId)
    if (Option.isSome(terminal)) return terminal
    const nowMs = yield* Clock.currentTimeMillis
    if (!requestTimedOut(request.createdAt, nowMs, abandonAfterMs)) {
      return Option.none()
    }
    return Option.some(yield* abandon(requestKind, request, nowMs, abandonAfterMs))
  })

const localContextForRequest = (
  request: ControlRequest,
): Effect.Effect<Option.Option<RuntimeContext>, unknown, CurrentHostSession | RuntimeControlPlaneTable> =>
  Effect.gen(function*() {
    const table = yield* runtimeControlPlaneTable
    const session = yield* currentHostSession
    const context = yield* table.contexts.get(request.contextId)
    if (Option.isNone(context)) return Option.none()
    return context.value.host.hostId === session.hostId ? context : Option.none()
  })

const failedCompletionFromCause = (
  kind: RuntimeControlRequestKind,
  request: ControlRequest,
  cause: Cause.Cause<unknown>,
): Effect.Effect<RuntimeControlRequestCompletionRow, unknown, CurrentHostSession | RuntimeControlPlaneTable> =>
  Effect.gen(function*() {
    const session = yield* currentHostSession
    const completedAtMs = yield* Clock.currentTimeMillis
    return yield* writeCompletion(kind, request, {
      status: "failed",
      hostId: session.hostId,
      completedAtMs,
      message: Cause.pretty(cause),
    })
  })

const provisionContextRequest = (
  request: RuntimeContextRequestRow,
  abandonAfterMs: number,
): Effect.Effect<
  RuntimeControlRequestCompletionRow,
  never,
  CurrentHostSession | RuntimeControlPlaneTable
> =>
  Effect.gen(function*() {
    const terminal = yield* terminalOrAbandonedCompletion("context", request, abandonAfterMs)
    if (Option.isSome(terminal)) return terminal.value
    const table = yield* runtimeControlPlaneTable
    const session = yield* currentHostSession
    const runtimeContext = yield* makeLocalRuntimeContextForHostSession(
      session,
      normalizeRuntimeIntent(request.runtime),
      {
        contextId: request.contextId,
        createdAtMs: createdAtMs(request.createdAt),
        ...(request.createdBy === undefined ? {} : { createdBy: request.createdBy }),
      },
    )
    yield* table.contexts.insertOrGet(runtimeContext)
    const completedAtMs = yield* Clock.currentTimeMillis
    return yield* writeCompletion("context", request, {
      status: "succeeded",
      hostId: session.hostId,
      completedAtMs,
    })
  }).pipe(
    Effect.catchAllCause(cause =>
      failedCompletionFromCause("context", request, cause).pipe(Effect.orDie)),
    Effect.withSpan("firegrid.host.control_request.context.workflow", {
      kind: "consumer",
      attributes: {
        "firegrid.context.id": request.contextId,
        "firegrid.control.request_id": request.requestId,
      },
    }),
    withRowOtelParent(request),
  )

const claimContextBoundRequest = (
  kind: RuntimeControlRequestKind,
  request: RuntimeStartRequestRow | RuntimeLifecycleRequestRow,
  abandonAfterMs: number,
): Effect.Effect<
  RuntimeControlRequestDispatchOutcome,
  never,
  CurrentHostSession | RuntimeControlPlaneTable
> =>
  Effect.gen(function*() {
    const terminal = yield* terminalOrAbandonedCompletion(kind, request, abandonAfterMs)
    if (Option.isSome(terminal)) return { _tag: "Done" } as const
    const context = yield* localContextForRequest(request)
    if (Option.isNone(context)) return { _tag: "Done" } as const
    const session = yield* currentHostSession
    return { _tag: "Claimed" as const, hostId: session.hostId }
  }).pipe(
    Effect.catchAllCause(cause =>
      failedCompletionFromCause(kind, request, cause).pipe(
        Effect.as({ _tag: "Done" } as const),
        Effect.orDie,
      )),
    Effect.withSpan("firegrid.host.control_request.claim.workflow", {
      kind: "consumer",
      attributes: {
        "firegrid.context.id": request.contextId,
        "firegrid.control.request_id": request.requestId,
        "firegrid.control.request_kind": kind,
      },
    }),
    withRowOtelParent(request),
  )

const runStartRequestSideEffect = (
  request: RuntimeStartRequestRow,
): Effect.Effect<
  void,
  unknown,
  | CurrentHostSession
  | RuntimeControlPlaneTable
  | RuntimeContextWorkflowRuntime
  | ChannelRegistry
  | AgentToolHost
  | RuntimeOutputTable
  | HostRuntimeContextExecutionEnv
  | Scope.Scope
> =>
  Effect.gen(function*() {
    if (yield* requestIsTerminal(request)) return
    const session = yield* currentHostSession
    const result = yield* startRuntime({ contextId: request.contextId }).pipe(
      Effect.tapError(cause =>
        Effect.gen(function*() {
          const completedAtMs = yield* Clock.currentTimeMillis
          yield* writeCompletion("start", request, {
            status: "failed",
            hostId: session.hostId,
            completedAtMs,
            message: cause instanceof Error ? cause.message : String(cause),
          })
        })),
    )
    const completedAtMs = yield* Clock.currentTimeMillis
    yield* writeCompletion("start", request, {
      status: "succeeded",
      hostId: session.hostId,
      completedAtMs,
      activityAttempt: result.activityAttempt,
      exitCode: result.exitCode,
      ...(result.signal === undefined ? {} : { signal: result.signal }),
    })
  }).pipe(
    Effect.withSpan("firegrid.host.control_request.start.side_effect", {
      kind: "consumer",
      attributes: {
        "firegrid.context.id": request.contextId,
        "firegrid.control.request_id": request.requestId,
      },
    }),
    withRowOtelParent(request),
  )

const activeActivityAttempt = (
  contextId: string,
): Effect.Effect<Option.Option<number>, unknown, RuntimeControlPlaneTable> =>
  Effect.gen(function*() {
    const table = yield* runtimeControlPlaneTable
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
    const table = yield* runtimeControlPlaneTable
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

const runLifecycleRequestSideEffect = (
  request: RuntimeLifecycleRequestRow,
): Effect.Effect<
  void,
  unknown,
  | CurrentHostSession
  | RuntimeControlPlaneTable
  | RuntimeContextWorkflowRuntime
  | ChannelRegistry
  | PerContextRuntimeOutputWriter
> =>
  Effect.gen(function*() {
    const kind: RuntimeControlRequestKind = request.lifecycle
    if (yield* requestIsTerminal(request)) return
    const context = yield* localContextForRequest(request)
    if (Option.isNone(context)) return
    const session = yield* currentHostSession
    const runtime = yield* RuntimeContextWorkflowRuntime
    yield* runtime.deregister(request.contextId)
    const completedAtMs = yield* Clock.currentTimeMillis
    yield* writeCompletion(kind, request, {
      status: "succeeded",
      hostId: session.hostId,
      completedAtMs,
    })
    yield* recordLifecycleTerminalEvidence(context.value, request)
  }).pipe(
    Effect.tapErrorCause(cause => failedCompletionFromCause(request.lifecycle, request, cause)),
    Effect.withSpan("firegrid.host.control_request.lifecycle.workflow", {
      kind: "consumer",
      attributes: {
        "firegrid.context.id": request.contextId,
        "firegrid.control.request_id": request.requestId,
        "firegrid.control.lifecycle": request.lifecycle,
      },
    }),
    withRowOtelParent(request),
  )

const controlRequestActivityName = (
  requestKind: RuntimeControlRequestKind,
  requestId: string,
): string => `runtime-control/${requestKind}/${requestId}`

const logWorkflowDispatchFailure = (
  requestKind: RuntimeControlRequestKind,
  request: ControlRequest,
  cause: Cause.Cause<unknown>,
) =>
  Effect.logError("[host-sdk] runtime control request workflow failed").pipe(
    Effect.annotateLogs({
      contextId: request.contextId,
      requestId: request.requestId,
      requestKind,
      cause: Cause.pretty(cause),
    }),
  )

export const RuntimeControlRequestWorkflowEngineLive = Layer.scoped(
  RuntimeControlRequestWorkflowEngine,
  Effect.gen(function*() {
    const config = yield* RuntimeHostConfig
    const session = yield* currentHostSession
    const scope = yield* Effect.scope
    const engineContext = yield* Layer.buildWithScope(
      DurableStreamsWorkflowEngine.layer({
        streamUrl: runtimeControlRequestWorkflowStreamUrl({
          baseUrl: config.durableStreamsBaseUrl,
          namespace: config.namespace,
        }),
        workerId: session.hostId,
        ...(config.headers === undefined ? {} : { headers: config.headers }),
      }),
      scope,
    )
    const engine = Context.get(engineContext, WorkflowEngine.WorkflowEngine)
    const captured = yield* Effect.context<RuntimeControlRequestWorkflowExecutionEnv>()

    yield* engine.register(RuntimeContextProvisionWorkflow, ({ request, abandonAfterMs }) =>
      Activity.make({
        name: controlRequestActivityName("context", request.requestId),
        success: RuntimeControlRequestCompletionRowSchema,
        execute: provisionContextRequest(request, abandonAfterMs).pipe(
          Effect.provide(captured),
        ),
      }))
    yield* engine.register(RuntimeStartWorkflow, ({ request, abandonAfterMs }) =>
      claimContextBoundRequest("start", request, abandonAfterMs).pipe(
        Effect.provide(captured),
      ))
    yield* engine.register(RuntimeLifecycleWorkflow, ({ request, abandonAfterMs }) =>
      claimContextBoundRequest(request.lifecycle, request, abandonAfterMs).pipe(
        Effect.provide(captured),
      ))

    const runContextProvision = (
      request: RuntimeContextRequestRow,
      options: ResolvedRuntimeControlRequestReconcilerOptions,
    ) =>
      engine.execute(RuntimeContextProvisionWorkflow, {
        executionId: runtimeControlRequestWorkflowExecutionId("context", request.requestId),
        payload: { request, abandonAfterMs: options.abandonAfterMs },
      }).pipe(Effect.asVoid)

    const runStart = (
      request: RuntimeStartRequestRow,
      options: ResolvedRuntimeControlRequestReconcilerOptions,
    ) => {
      const run = Effect.gen(function*() {
        const outcome = yield* engine.execute(RuntimeStartWorkflow, {
          executionId: runtimeControlRequestWorkflowExecutionId("start", request.requestId),
          payload: { request, abandonAfterMs: options.abandonAfterMs },
        })
        if (outcome._tag !== "Claimed" || outcome.hostId !== session.hostId) return
        yield* runStartRequestSideEffect(request).pipe(Effect.provide(captured))
      })
      return options.startRequestExecution === "background"
        ? run.pipe(
          Effect.catchAllCause(cause =>
            Cause.isInterruptedOnly(cause)
              ? Effect.interrupt
              : logWorkflowDispatchFailure("start", request, cause)),
          Effect.forkIn(scope),
          Effect.asVoid,
        )
        : run
    }

    const runLifecycle = (
      request: RuntimeLifecycleRequestRow,
      options: ResolvedRuntimeControlRequestReconcilerOptions,
    ) => Effect.gen(function*() {
      const outcome = yield* engine.execute(RuntimeLifecycleWorkflow, {
        executionId: runtimeControlRequestWorkflowExecutionId(request.lifecycle, request.requestId),
        payload: { request, abandonAfterMs: options.abandonAfterMs },
      })
      if (outcome._tag !== "Claimed" || outcome.hostId !== session.hostId) return
      yield* runLifecycleRequestSideEffect(request).pipe(Effect.provide(captured))
    })

    return RuntimeControlRequestWorkflowEngine.of({
      contextProvision: runContextProvision,
      start: runStart,
      lifecycle: runLifecycle,
    })
  }).pipe(
    Effect.withSpan("firegrid.host.control_request.workflow_engine.layer", {
      kind: "internal",
    }),
  ),
)

const requestIsTerminal = (
  request: ControlRequest,
): Effect.Effect<boolean, unknown, RuntimeControlPlaneTable> =>
  Effect.gen(function*() {
    const table = yield* runtimeControlPlaneTable
    return hasTerminal(yield* table.controlRequestCompletions.get(request.requestId))
  })

const shouldDispatchContextBoundRequest = (
  request: ControlRequest,
  options: ResolvedRuntimeControlRequestReconcilerOptions,
): Effect.Effect<boolean, unknown, CurrentHostSession | RuntimeControlPlaneTable> =>
  Effect.gen(function*() {
    if (yield* requestIsTerminal(request)) return false
    const nowMs = yield* Clock.currentTimeMillis
    if (requestTimedOut(request.createdAt, nowMs, options.abandonAfterMs)) return true
    return Option.isSome(yield* localContextForRequest(request))
  })

const reconcileContextRequest = (
  request: RuntimeContextRequestRow,
  options: ResolvedRuntimeControlRequestReconcilerOptions,
): Effect.Effect<void, unknown, RuntimeControlRequestWorkflowEngine | Scope.Scope> =>
  RuntimeControlRequestWorkflowEngine.pipe(
    Effect.flatMap(engine => engine.contextProvision(request, options)),
    Effect.withSpan("firegrid.host.control_request.context.dispatch", {
      kind: "producer",
      attributes: {
        "firegrid.context.id": request.contextId,
        "firegrid.control.request_id": request.requestId,
      },
    }),
  )

const reconcileContextBoundRequest = (
  request: RuntimeStartRequestRow | RuntimeLifecycleRequestRow,
  options: ResolvedRuntimeControlRequestReconcilerOptions,
  dispatch: (
    engine: RuntimeControlRequestWorkflowEngine["Type"],
  ) => Effect.Effect<void, unknown, Scope.Scope>,
  spanName: string,
  attributes: Record<string, string>,
): Effect.Effect<
  void,
  unknown,
  CurrentHostSession | RuntimeControlPlaneTable | RuntimeControlRequestWorkflowEngine | Scope.Scope
> =>
  Effect.gen(function*() {
    if (!(yield* shouldDispatchContextBoundRequest(request, options))) return
    const engine = yield* RuntimeControlRequestWorkflowEngine
    yield* dispatch(engine)
  }).pipe(
    Effect.withSpan(spanName, {
      kind: "producer",
      attributes,
    }),
  )

const reconcileStartRequest = (
  request: RuntimeStartRequestRow,
  options: ResolvedRuntimeControlRequestReconcilerOptions,
) =>
  reconcileContextBoundRequest(
    request,
    options,
    engine => engine.start(request, options),
    "firegrid.host.control_request.start.dispatch",
    {
      "firegrid.context.id": request.contextId,
      "firegrid.control.request_id": request.requestId,
    },
  )

const reconcileLifecycleRequest = (
  request: RuntimeLifecycleRequestRow,
  options: ResolvedRuntimeControlRequestReconcilerOptions,
) =>
  reconcileContextBoundRequest(
    request,
    options,
    engine => engine.lifecycle(request, options),
    "firegrid.host.control_request.lifecycle.dispatch",
    {
        "firegrid.context.id": request.contextId,
        "firegrid.control.request_id": request.requestId,
        "firegrid.control.lifecycle": request.lifecycle,
    },
  )

const reconcileLifecycleRequestsOnce = (
  resolved: ResolvedRuntimeControlRequestReconcilerOptions,
): Effect.Effect<
  number,
  unknown,
  CurrentHostSession | RuntimeControlPlaneTable | RuntimeControlRequestWorkflowEngine | Scope.Scope
> =>
  Effect.gen(function*() {
    const table = yield* runtimeControlPlaneTable
    const lifecycleRequests = yield* table.lifecycleRequests.query((coll) => coll.toArray)
    yield* Effect.annotateCurrentSpan({
      "firegrid.control.lifecycle_request_count": lifecycleRequests.length,
    })
    yield* Effect.forEach(
      lifecycleRequests,
      request => reconcileLifecycleRequest(request, resolved),
      { discard: true },
    )
    yield* annotateReconcileOutcome(lifecycleRequests.length === 0 ? "noop" : "completed")
    return lifecycleRequests.length
  }).pipe(
    Effect.tapError(() => annotateReconcileOutcome("errored")),
    Effect.withSpan("firegrid.host.control_request.lifecycle.reconcile_once", {
      kind: "internal",
    }),
    Effect.annotateSpans("firegrid.side", "host"),
  )

export const reconcileRuntimeControlRequestsOnce = (
  options: RuntimeControlRequestReconcilerOptions = {},
): Effect.Effect<void, unknown, RuntimeControlRequestReconcilerEnvironment> => {
  const resolved = resolveOptions(options)
  return Effect.gen(function*() {
    const table = yield* runtimeControlPlaneTable
    const contextRequests = yield* table.contextRequests.query((coll) => coll.toArray)
    yield* Effect.annotateCurrentSpan({
      "firegrid.control.context_request_count": contextRequests.length,
    })
    yield* Effect.forEach(
      contextRequests,
      request => reconcileContextRequest(request, resolved),
      { discard: true },
    )
    const lifecycleRequestCount = yield* reconcileLifecycleRequestsOnce(resolved)
    const startRequests = yield* table.startRequests.query((coll) => coll.toArray)
    yield* Effect.annotateCurrentSpan({
      "firegrid.control.start_request_count": startRequests.length,
    })
    yield* Effect.forEach(
      startRequests,
      request => reconcileStartRequest(request, resolved),
      { discard: true },
    )
    yield* annotateReconcileOutcome(
      contextRequests.length + lifecycleRequestCount + startRequests.length === 0 ? "noop" : "completed",
    )
  }).pipe(
    Effect.tapError(() => annotateReconcileOutcome("errored")),
    Effect.withSpan("firegrid.host.control_request.reconcile_once", {
      kind: "internal",
    }),
    Effect.annotateSpans("firegrid.side", "host"),
  )
}

export const runRuntimeControlRequestReconciler = (
  options: RuntimeControlRequestReconcilerOptions = {},
): Effect.Effect<never, never, RuntimeControlRequestReconcilerEnvironment> => {
  const daemonOptions = {
    startRequestExecution: "background" as const,
    ...options,
  }
  const resolved = resolveOptions(daemonOptions)
  const restartOnFailure = <R>(
    effect: Effect.Effect<unknown, unknown, R>,
    streamName: string,
  ): Effect.Effect<never, never, R> =>
    effect.pipe(
      Effect.catchAllCause(cause =>
        Cause.isInterruptedOnly(cause)
          ? Effect.interrupt
          : Effect.logError("[host-sdk] runtime control request reconciliation failed").pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause), stream: streamName }),
            Effect.zipRight(Effect.sleep(Duration.seconds(1))),
          )),
      Effect.forever,
    )
  const reconcileStartsForContext = (contextId: string) =>
    Effect.gen(function*() {
      const table = yield* runtimeControlPlaneTable
      const startRequests = yield* table.startRequests.query((coll) =>
        coll.toArray.filter(request => request.contextId === contextId))
      yield* Effect.forEach(
        startRequests,
        request => reconcileStartRequest(request, resolved),
        { discard: true },
      )
    })
  const contextRows = Effect.gen(function*() {
    const table = yield* runtimeControlPlaneTable
    yield* table.contextRequests.rows().pipe(
      Stream.runForEach(request =>
        reconcileContextRequest(request, resolved).pipe(
          Effect.zipRight(reconcileStartsForContext(request.contextId)),
        )),
    )
  })
  const startRows = Effect.gen(function*() {
    const table = yield* runtimeControlPlaneTable
    yield* table.startRequests.rows().pipe(
      Stream.runForEach(request => reconcileStartRequest(request, resolved)),
    )
  })
  const lifecycleRows = Effect.gen(function*() {
    const table = yield* runtimeControlPlaneTable
    yield* table.lifecycleRequests.rows().pipe(
      Stream.runForEach(request => reconcileLifecycleRequest(request, resolved)),
    )
  })

  return reconcileRuntimeControlRequestsOnce(daemonOptions).pipe(
    Effect.catchAllCause(cause =>
      Cause.isInterruptedOnly(cause)
        ? Effect.interrupt
        : Effect.logError("[host-sdk] runtime control request startup reconciliation failed").pipe(
          Effect.annotateLogs({ cause: Cause.pretty(cause) }),
        )),
    Effect.zipRight(Effect.all(
      [
        restartOnFailure(contextRows, "context"),
        restartOnFailure(startRows, "start"),
        restartOnFailure(lifecycleRows, "lifecycle"),
      ],
      { concurrency: "unbounded", discard: true },
    )),
    Effect.zipRight(Effect.never),
  )
}

export const RuntimeControlRequestReconcilerLive = Layer.succeed(
  RuntimeControlRequestReconciler,
  RuntimeControlRequestReconciler.of({
    reconcileOnce: reconcileRuntimeControlRequestsOnce,
    run: runRuntimeControlRequestReconciler,
  }),
)

export const RuntimeControlRequestReconcilerDaemonLive = Layer.scopedDiscard(
  Effect.forkScoped(runRuntimeControlRequestReconciler()).pipe(Effect.asVoid),
).pipe(
  Layer.provideMerge(RuntimeControlRequestWorkflowEngineLive),
)
