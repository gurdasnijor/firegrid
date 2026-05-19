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
  type RuntimeOutputTable,
  type RuntimeStartRequestRow,
} from "@firegrid/protocol/launch"
import { Cause, Clock, Context, Duration, Effect, Layer, Option } from "effect"
import type { AgentToolHost } from "../agent-tools/execution/tool-host.ts"
import { startRuntime } from "./commands.ts"
import type { RuntimeContextEngineRegistry } from "./runtime-context-engine-registry.ts"
import type { RuntimeContextWorkflowSession } from "./runtime-context-workflow-core.ts"
import type { HostRuntimeContextExecutionEnv } from "./runtime-substrate.ts"

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
  | AgentToolHost
  | RuntimeOutputTable
  | HostRuntimeContextExecutionEnv
  // TFIND-045 (y residual-z, tf-uiz DECIDED y; verdict-authorized):
  // y root-narrow at #350 workflow-core makes RuntimeContextWorkflowSession
  // a precise transitive requirement of startRuntime()->claimAndRun...;
  // startRuntime does not Effect.provide a captured env, so the
  // reconciler env alias must declare it (broadened-#347 explicit-R).
  // Provided at runtime by the composed Firegrid host layer
  // (RuntimeContextWorkflowSessionLive).
  | RuntimeContextWorkflowSession

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

type ControlRequest = RuntimeContextRequestRow | RuntimeStartRequestRow

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
  })

const skipOrAbandonTerminalRequest = (
  requestKind: RuntimeControlRequestKind,
  request: ControlRequest,
  options: Required<Omit<RuntimeControlRequestReconcilerOptions, "pollIntervalMs">>,
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
  })

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
    return result._tag === "Inserted"
  })

const reconcileContextRequest = (
  request: RuntimeContextRequestRow,
  options: Required<Omit<RuntimeControlRequestReconcilerOptions, "pollIntervalMs">>,
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
  })

const reconcileStartRequest = (
  request: RuntimeStartRequestRow,
  options: Required<Omit<RuntimeControlRequestReconcilerOptions, "pollIntervalMs">>,
): Effect.Effect<void, unknown, RuntimeControlRequestReconcilerEnvironment> =>
  Effect.gen(function*() {
    const table = yield* runtimeControlPlaneTable
    const session = yield* currentHostSession
    const nowMs = yield* skipOrAbandonTerminalRequest("start", request, options)
    if (Option.isNone(nowMs)) return

    const context = yield* table.contexts.get(request.contextId)
    if (Option.isNone(context)) return

    if (!(yield* winClaim("start", request, nowMs.value, options.claimWindowMs))) return
    if (hasTerminal(yield* table.controlRequestCompletions.get(request.requestId))) return

    const result = yield* startRuntime({ contextId: request.contextId }).pipe(
      Effect.tapError(cause =>
        writeCompletion("start", request, {
          status: "failed",
          hostId: session.hostId,
          completedAtMs: nowMs.value,
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
  })

export const reconcileRuntimeControlRequestsOnce = (
  options: RuntimeControlRequestReconcilerOptions = {},
): Effect.Effect<void, unknown, RuntimeControlRequestReconcilerEnvironment> => {
  const resolved = {
    claimWindowMs: optionValue(
      options.claimWindowMs,
      runtimeControlRequestReconcilerDefaults.claimWindowMs,
    ),
    abandonAfterMs: optionValue(
      options.abandonAfterMs,
      runtimeControlRequestReconcilerDefaults.abandonAfterMs,
    ),
  }
  return Effect.gen(function*() {
    const table = yield* runtimeControlPlaneTable
    const contextRequests = yield* table.contextRequests.query((coll) => coll.toArray)
    yield* Effect.forEach(
      contextRequests,
      request => reconcileContextRequest(request, resolved),
      { discard: true },
    )
    const startRequests = yield* table.startRequests.query((coll) => coll.toArray)
    yield* Effect.forEach(
      startRequests,
      request => reconcileStartRequest(request, resolved),
      { discard: true },
    )
  })
}

export const runRuntimeControlRequestReconciler = (
  options: RuntimeControlRequestReconcilerOptions = {},
): Effect.Effect<never, never, RuntimeControlRequestReconcilerEnvironment> => {
  const pollIntervalMs = optionValue(
    options.pollIntervalMs,
    runtimeControlRequestReconcilerDefaults.pollIntervalMs,
  )
  const tick: Effect.Effect<
    void,
    never,
    RuntimeControlRequestReconcilerEnvironment
  > = reconcileRuntimeControlRequestsOnce(options).pipe(
    Effect.catchAllCause(cause =>
      Effect.logError("[host-sdk] runtime control request reconciliation failed").pipe(
        Effect.annotateLogs({ cause: Cause.pretty(cause) }),
      )),
    Effect.zipRight(Effect.sleep(Duration.millis(pollIntervalMs))),
  )
  return tick.pipe(Effect.forever)
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
