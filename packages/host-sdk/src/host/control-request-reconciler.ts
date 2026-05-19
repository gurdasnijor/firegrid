import {
  CurrentHostSession,
  RuntimeControlPlaneTable,
  makeLocalRuntimeContextForHostSession,
  makeRuntimeControlRequestClaimRow,
  makeRuntimeControlRequestCompletionRow,
  normalizeRuntimeIntent,
  type RuntimeContextRequestRow,
  type RuntimeControlRequestCompletionRow,
  type RuntimeControlRequestKind,
  type RuntimeContext,
  type RuntimeLifecycleRequestRow,
  type RuntimeOutputTable,
  type RuntimeStartRequestRow,
} from "@firegrid/protocol/launch"
import { Cause, Clock, Context, Duration, Effect, Layer, Option } from "effect"
import { withRowOtelParent } from "@firegrid/protocol/otel"
import type { AgentToolHost } from "../agent-tools/execution/tool-host.ts"
import { startRuntime } from "./commands.ts"
import { RuntimeContextEngineRegistry } from "./runtime-context-engine-registry.ts"
import type { HostRuntimeContextExecutionEnv } from "./runtime-substrate.ts"
import { PerContextRuntimeOutputWriter } from "./per-context-runtime-output.ts"

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
  claimWindowMs: 60_000,
  abandonAfterMs: 600_000,
} as const

export interface RuntimeControlRequestReconcilerOptions {
  readonly pollIntervalMs?: number
  readonly claimWindowMs?: number
  readonly abandonAfterMs?: number
}

type ResolvedRuntimeControlRequestReconcilerOptions = Required<
  Omit<RuntimeControlRequestReconcilerOptions, "pollIntervalMs">
>

// TFIND-045: `reconcileStartRequest` calls `startRuntime()`, which
// transitively requires `RuntimeOutputTable` and
// `HostRuntimeContextExecutionEnv` via `RuntimeContextEngineRegistry`.
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
  | RuntimeContextEngineRegistry
  | PerContextRuntimeOutputWriter
  | AgentToolHost
  | RuntimeOutputTable
  | HostRuntimeContextExecutionEnv

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
  claimWindowMs: optionValue(
    options.claimWindowMs,
    runtimeControlRequestReconcilerDefaults.claimWindowMs,
  ),
  abandonAfterMs: optionValue(
    options.abandonAfterMs,
    runtimeControlRequestReconcilerDefaults.abandonAfterMs,
  ),
})

const createdAtMs = (createdAt: string): number => {
  const parsed = Date.parse(createdAt)
  return Number.isFinite(parsed) ? parsed : 0
}

const claimWindowStartedAtMs = (
  nowMs: number,
  claimWindowMs: number,
): number => Math.floor(nowMs / claimWindowMs) * claimWindowMs

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
): Effect.Effect<void, unknown, RuntimeControlPlaneTable> =>
  Effect.gen(function*() {
    const table = yield* runtimeControlPlaneTable
    yield* table.controlRequestCompletions.insertOrGet(
      makeRuntimeControlRequestCompletionRow({
        ...input,
        requestKind,
        requestId: request.requestId,
        contextId: request.contextId,
      }),
    )
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

const skipOrAbandonTerminalRequest = (
  requestKind: RuntimeControlRequestKind,
  request: ControlRequest,
  options: ResolvedRuntimeControlRequestReconcilerOptions,
) =>
  Effect.gen(function*() {
    const table = yield* runtimeControlPlaneTable
    const nowMs = yield* Clock.currentTimeMillis
    if (hasTerminal(yield* table.controlRequestCompletions.get(request.requestId))) {
      return Option.none<number>()
    }
    if (requestTimedOut(request.createdAt, nowMs, options.abandonAfterMs)) {
      yield* abandon(requestKind, request, nowMs, options.abandonAfterMs)
      return Option.none<number>()
    }
    return Option.some(nowMs)
  })

const abandon = (
  requestKind: RuntimeControlRequestKind,
  request: ControlRequest,
  nowMs: number,
  abandonAfterMs: number,
): Effect.Effect<void, unknown, CurrentHostSession | RuntimeControlPlaneTable> =>
  Effect.gen(function*() {
    const session = yield* currentHostSession
    yield* writeCompletion(requestKind, request, {
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

const winClaim = (
  requestKind: RuntimeControlRequestKind,
  request: ControlRequest,
  nowMs: number,
  claimWindowMs: number,
): Effect.Effect<boolean, unknown, CurrentHostSession | RuntimeControlPlaneTable> =>
  Effect.gen(function*() {
    const table = yield* runtimeControlPlaneTable
    const session = yield* currentHostSession
    const windowStartedAtMs = claimWindowStartedAtMs(nowMs, claimWindowMs)
    const result = yield* table.controlRequestClaims.insertOrGet(
      makeRuntimeControlRequestClaimRow({
        requestKind,
        requestId: request.requestId,
        contextId: request.contextId,
        hostId: session.hostId,
        hostSessionId: session.hostSessionId,
        claimWindowStartedAtMs: windowStartedAtMs,
        claimWindowExpiresAtMs: windowStartedAtMs + claimWindowMs,
        claimedAtMs: nowMs,
      }),
    )
    yield* Effect.annotateCurrentSpan({
      "firegrid.control.claim_won": result._tag === "Inserted",
    })
    return result._tag === "Inserted"
  }).pipe(
    Effect.withSpan("firegrid.host.control_request.claim", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": request.contextId,
        "firegrid.control.request_id": request.requestId,
        "firegrid.control.request_kind": requestKind,
      },
    }),
  )

const reconcileContextRequest = (
  request: RuntimeContextRequestRow,
  options: ResolvedRuntimeControlRequestReconcilerOptions,
): Effect.Effect<
  void,
  unknown,
  CurrentHostSession | RuntimeControlPlaneTable
> =>
  Effect.gen(function*() {
    const table = yield* runtimeControlPlaneTable
    const session = yield* currentHostSession
    const nowMs = yield* skipOrAbandonTerminalRequest("context", request, options)
    if (Option.isNone(nowMs)) return

    if (!(yield* winClaim("context", request, nowMs.value, options.claimWindowMs))) return
    if (hasTerminal(yield* table.controlRequestCompletions.get(request.requestId))) return

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
    yield* writeCompletion("context", request, {
      status: "succeeded",
      hostId: session.hostId,
      completedAtMs,
    })
  }).pipe(
    Effect.withSpan("firegrid.host.control_request.context.reconcile", {
      kind: "consumer",
      attributes: {
        "firegrid.context.id": request.contextId,
        "firegrid.control.request_id": request.requestId,
      },
    }),
    // Parent ALL spans under this reconcile (the named span + everything it
    // calls into) to the client-side append span recorded on the row.
    withRowOtelParent(request),
  )

// Shared claim preamble for reconcilable control requests that act on an
// already-existing context (start, cancel, close): resolve the host
// session, skip/abandon terminal, require the context to exist, win the
// first-writer claim, and re-check terminal. `Option.none` ⇒ the caller
// returns early. Extracted so the start/lifecycle arms do not duplicate it.
const acquireReconcileClaim = (
  kind: RuntimeControlRequestKind,
  request: ControlRequest,
  options: ResolvedRuntimeControlRequestReconcilerOptions,
): Effect.Effect<
  Option.Option<{
    readonly session: CurrentHostSession["Type"]
    readonly context: RuntimeContext
    readonly nowMs: number
  }>,
  unknown,
  CurrentHostSession | RuntimeControlPlaneTable
> =>
  Effect.gen(function*() {
    const table = yield* runtimeControlPlaneTable
    const session = yield* currentHostSession
    const nowMs = yield* skipOrAbandonTerminalRequest(kind, request, options)
    if (Option.isNone(nowMs)) return Option.none()
    const context = yield* table.contexts.get(request.contextId)
    if (Option.isNone(context)) return Option.none()
    if (!(yield* winClaim(kind, request, nowMs.value, options.claimWindowMs))) {
      return Option.none()
    }
    if (hasTerminal(yield* table.controlRequestCompletions.get(request.requestId))) {
      return Option.none()
    }
    return Option.some({ session, context: context.value, nowMs: nowMs.value })
  })

const reconcileStartRequest = (
  request: RuntimeStartRequestRow,
  options: ResolvedRuntimeControlRequestReconcilerOptions,
): Effect.Effect<void, unknown, RuntimeControlRequestReconcilerEnvironment> =>
  Effect.gen(function*() {
    const claim = yield* acquireReconcileClaim("start", request, options)
    if (Option.isNone(claim)) return
    const { nowMs, session } = claim.value

    const result = yield* startRuntime({ contextId: request.contextId }).pipe(
      Effect.tapError(cause =>
        writeCompletion("start", request, {
          status: "failed",
          hostId: session.hostId,
          completedAtMs: nowMs,
          message: cause instanceof Error ? cause.message : String(cause),
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
    Effect.withSpan("firegrid.host.control_request.start.reconcile", {
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

// tf-4ni: durable session-lifecycle terminate (cancel/close). Mirrors
// `reconcileStartRequest`. The per-context engine terminal action is the
// existing host-local `RuntimeContextEngineRegistry.deregister` (closes the
// active engine scope; safe no-op if this host generation holds no active
// engine). The durable, cross-host-observable terminal state is the
// kind-generic completion row written to `RuntimeControlPlaneTable` — it
// survives host generations exactly like the context/start completion. No
// `SandboxProvider`/`HostRuntimeContextExecutionEnv` widening: deregister
// needs only the registry the reconciler env already declares.
const reconcileLifecycleRequest = (
  request: RuntimeLifecycleRequestRow,
  options: ResolvedRuntimeControlRequestReconcilerOptions,
): Effect.Effect<
  void,
  unknown,
  | CurrentHostSession
  | RuntimeControlPlaneTable
  | RuntimeContextEngineRegistry
  | PerContextRuntimeOutputWriter
> =>
  Effect.gen(function*() {
    const kind: RuntimeControlRequestKind = request.lifecycle
    const claim = yield* acquireReconcileClaim(kind, request, options)
    if (Option.isNone(claim)) return
    const { context, nowMs, session } = claim.value

    const registry = yield* RuntimeContextEngineRegistry
    yield* registry.deregister(request.contextId).pipe(
      Effect.tapErrorCause(cause =>
        writeCompletion(kind, request, {
          status: "failed",
          hostId: session.hostId,
          completedAtMs: nowMs,
          message: Cause.pretty(cause),
        })),
    )
    const completedAtMs = yield* Clock.currentTimeMillis
    yield* writeCompletion(kind, request, {
      status: "succeeded",
      hostId: session.hostId,
      completedAtMs,
    })
    yield* recordLifecycleTerminalEvidence(context, request)
  }).pipe(
    Effect.withSpan("firegrid.host.control_request.lifecycle.reconcile", {
      kind: "consumer",
      attributes: {
        "firegrid.context.id": request.contextId,
        "firegrid.control.request_id": request.requestId,
        "firegrid.control.lifecycle": request.lifecycle,
      },
    }),
    withRowOtelParent(request),
  )

const reconcileLifecycleRequestsOnce = (
  resolved: ResolvedRuntimeControlRequestReconcilerOptions,
): Effect.Effect<
  number,
  unknown,
  | CurrentHostSession
  | RuntimeControlPlaneTable
  | RuntimeContextEngineRegistry
  | PerContextRuntimeOutputWriter
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
  const pollIntervalMs = optionValue(
    options.pollIntervalMs,
    runtimeControlRequestReconcilerDefaults.pollIntervalMs,
  )
  const resolved = resolveOptions(options)
  const loop = <R>(
    effect: Effect.Effect<unknown, unknown, R>,
    spanName: string,
  ): Effect.Effect<never, never, R> =>
    effect.pipe(
      Effect.catchAllCause(cause =>
        Effect.logError("[host-sdk] runtime control request reconciliation failed").pipe(
          Effect.annotateLogs({ cause: Cause.pretty(cause), loop: spanName }),
        )),
      Effect.zipRight(Effect.sleep(Duration.millis(pollIntervalMs))),
      Effect.forever,
    )
  const controlLoop: Effect.Effect<
    never,
    never,
    RuntimeControlRequestReconcilerEnvironment
  > = loop(
    reconcileRuntimeControlRequestsOnce(options),
    "control",
  )
  const lifecycleLoop: Effect.Effect<
    never,
    never,
    | CurrentHostSession
    | RuntimeControlPlaneTable
    | RuntimeContextEngineRegistry
    | PerContextRuntimeOutputWriter
  > = loop(
    reconcileLifecycleRequestsOnce(resolved),
    "lifecycle",
  )

  return Effect.all(
    [controlLoop, lifecycleLoop],
    { concurrency: "unbounded", discard: true },
  ).pipe(Effect.zipRight(Effect.never))
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
)
