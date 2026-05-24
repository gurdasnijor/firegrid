import {
  CurrentHostSession,
  RuntimeControlPlaneTable,
  makeLocalRuntimeContextForHostSession,
  makeRuntimeControlRequestClaimRow,
  makeRuntimeControlRequestCompletionRow,
  requireLocalContext,
  type HostSessionRow,
  type RuntimeContextRequestRow,
  type RuntimeContext,
  type RuntimeContextIntent,
  type RuntimeControlRequestCompletionRow,
  type RuntimeControlRequestKind,
  type RuntimeLifecycleRequestRow,
  type RuntimeRunEventRow,
  type RuntimeStartRequestRow,
} from "@firegrid/protocol/launch"
import { Clock, Context, Effect, Layer, Option, Stream } from "effect"
import { authorityNowIso } from "./runtime-control-plane-time.ts"

type RuntimeControlRequestRow =
  | RuntimeContextRequestRow
  | RuntimeStartRequestRow
  | RuntimeLifecycleRequestRow

interface RuntimeControlRequestCompletionInput {
  readonly status: RuntimeControlRequestCompletionRow["status"]
  readonly hostId: string
  readonly completedAtMs: number
  readonly activityAttempt?: number
  readonly exitCode?: number
  readonly signal?: string
  readonly message?: string
}

export interface RuntimeContextInsertService {
  readonly insertLocalContext: (
    intent: RuntimeContextIntent,
    options: {
      readonly contextId: string
      readonly createdBy?: string
    },
  ) => Effect.Effect<RuntimeContext, unknown>
  readonly insertLocalContextIfAbsent: (
    intent: RuntimeContextIntent,
    options: {
      readonly contextId: string
      readonly createdBy?: string
      readonly createdAtMs?: number
    },
  ) => Effect.Effect<RuntimeContext, unknown>
}

export interface RuntimeContextReadService {
  readonly readContext: (
    contextId: string,
  ) => Effect.Effect<Option.Option<RuntimeContext>, unknown>
}

export interface RuntimeLocalContextResolverService {
  readonly requireLocalContext: (
    contextId: string,
  ) => Effect.Effect<RuntimeContext, unknown>
}

export interface RuntimeRunAppendAndGetService {
  readonly allocateActivityAttempt: (
    context: RuntimeContext,
  ) => Effect.Effect<number, unknown>
  readonly recordStarted: (
    context: RuntimeContext,
    activityAttempt: number,
  ) => Effect.Effect<void, unknown>
  readonly recordExited: (
    context: RuntimeContext,
    activityAttempt: number,
    exit: {
      readonly exitCode: number
      readonly signal?: string | undefined
    },
  ) => Effect.Effect<void, unknown>
  /**
   * Latest `runs.started` row's `activityAttempt` per `contextId`. Wave D-A
   * Shape (b) Q2 directive: the Shape C subscriber resolves the in-flight
   * attempt for an event by reading the durable runs table through this
   * typed table service, never by extracting `RuntimeControlPlaneTable`
   * directly (which is forbidden outside `tables/`).
   *
   * Returns `Option.none()` when no `runs.started` row exists for the
   * contextId yet; the subscriber drops the event in that case (the
   * spawn handshake from `SideEffects.start` writes the started row;
   * the next event materialization picks it up).
   */
  readonly latestStartedAttempt: (
    contextId: string,
  ) => Effect.Effect<Option.Option<number>, unknown>
  /**
   * Wave D-A Shape (b): wait for the terminal (`exited` | `failed`)
   * `RuntimeRunEvent` row for a specific `(contextId, activityAttempt)`.
   * Used by `SideEffects.start` to block until the Shape C subscriber
   * writes the terminal row (via `recordExited` on Terminated, or
   * `recordFailed` on start error). The Shape C subscriber is the sole
   * production writer of terminal rows post-D-A.
   *
   * Table-side `Stream.runHead` keeps `RuntimeControlPlaneTable`
   * confined to `tables/`; callers consume the typed result without
   * yielding the table service directly.
   *
   * Returns `Option.none()` only if the underlying runs stream ends
   * before a terminal row arrives — a substrate-level error condition
   * that the caller surfaces as failure.
   */
  readonly waitTerminal: (
    contextId: string,
    activityAttempt: number,
  ) => Effect.Effect<Option.Option<RuntimeRunEventRow>, unknown>
  readonly recordFailed: (
    context: RuntimeContext,
    activityAttempt: number,
    message: string,
  ) => Effect.Effect<void, unknown>
}

interface RuntimeControlRequestsService {
  /**
   * First-writer-wins claim against the durable `controlRequestClaims` table.
   * Used by side-effect handlers (e.g. start) that perform non-idempotent
   * external work to dedupe concurrent reconcile attempts at the row level
   * — independent of any in-process workflow-engine memoization (which does
   * not span separate engine instances within the same host process).
   *
   * Returns `{ _tag: "Inserted" }` when this caller wins the claim and may
   * proceed with the side effect, or `{ _tag: "Found" }` when another caller
   * already owns the claim and the side effect must be skipped.
   */
  readonly insertOrGetClaim: (
    input: {
      readonly requestKind: RuntimeControlRequestKind
      readonly requestId: string
      readonly contextId: string
      readonly hostId: string
      readonly hostSessionId: string
    },
  ) => Effect.Effect<
    | { readonly _tag: "Inserted" }
    | { readonly _tag: "Found" },
    unknown
  >
  readonly writeCompletion: (
    requestKind: RuntimeControlRequestKind,
    request: RuntimeControlRequestRow,
    input: RuntimeControlRequestCompletionInput,
  ) => Effect.Effect<RuntimeControlRequestCompletionRow, unknown>
  readonly completionForRequest: (
    requestId: string,
  ) => Effect.Effect<Option.Option<RuntimeControlRequestCompletionRow>, unknown>
  readonly contextRequests: Effect.Effect<ReadonlyArray<RuntimeContextRequestRow>, unknown>
  readonly startRequests: Effect.Effect<ReadonlyArray<RuntimeStartRequestRow>, unknown>
  readonly lifecycleRequests: Effect.Effect<ReadonlyArray<RuntimeLifecycleRequestRow>, unknown>
  readonly startRequestsForContext: (
    contextId: string,
  ) => Effect.Effect<ReadonlyArray<RuntimeStartRequestRow>, unknown>
  readonly contextRequestRows: Stream.Stream<RuntimeContextRequestRow, unknown>
  readonly startRequestRows: Stream.Stream<RuntimeStartRequestRow, unknown>
  readonly lifecycleRequestRows: Stream.Stream<RuntimeLifecycleRequestRow, unknown>
}

const writeControlRequestCompletionTo = (
  table: RuntimeControlPlaneTable["Type"],
  requestKind: RuntimeControlRequestKind,
  request: RuntimeControlRequestRow,
  input: RuntimeControlRequestCompletionInput,
) =>
  Effect.gen(function* () {
    const row = makeRuntimeControlRequestCompletionRow({
      ...input,
      requestKind,
      requestId: request.requestId,
      contextId: request.contextId,
    })
    const result = yield* table.controlRequestCompletions.insertOrGet(row)
    return result._tag === "Found" ? result.row : row
  }).pipe(
    Effect.withSpan("firegrid.runtime_control_plane.control_request.completion.write", {
      kind: "producer",
      attributes: {
        "firegrid.context.id": request.contextId,
        "firegrid.control.request_id": request.requestId,
        "firegrid.control.request_kind": requestKind,
        "firegrid.control.completion_status": input.status,
      },
    }),
  )

const controlRequestsFromTable = (
  table: RuntimeControlPlaneTable["Type"],
): RuntimeControlRequestsService => ({
  // First-writer-wins claim against the durable `controlRequestClaims`
  // table. Anchored at `claimWindowStartedAtMs: 0` so the deterministic
  // `claimId = controlRequestClaimId(requestKind, requestId, 0)` collides
  // across concurrent attempts for the same request — `insertOrGet` then
  // returns `Inserted` to the winner and `Found` to everyone else. Used
  // by side-effect handlers (start) to dedupe non-idempotent external
  // work across separate reconciler/engine instances in the same host
  // process (cf. duplicate-prevention test PHASE_1.4).
  insertOrGetClaim: (input) =>
    Effect.gen(function* () {
      const claimedAtMs = yield* Clock.currentTimeMillis
      const row = makeRuntimeControlRequestClaimRow({
        requestKind: input.requestKind,
        requestId: input.requestId,
        contextId: input.contextId,
        hostId: input.hostId,
        hostSessionId: input.hostSessionId,
        claimWindowStartedAtMs: 0,
        claimWindowExpiresAtMs: Number.MAX_SAFE_INTEGER,
        claimedAtMs,
      })
      const result = yield* table.controlRequestClaims.insertOrGet(row)
      return result._tag === "Inserted"
        ? { _tag: "Inserted" as const }
        : { _tag: "Found" as const }
    }).pipe(
      Effect.withSpan(
        "firegrid.runtime_control_plane.control_request.claim.insert_or_get",
        {
          kind: "producer",
          attributes: {
            "firegrid.context.id": input.contextId,
            "firegrid.control.request_id": input.requestId,
            "firegrid.control.request_kind": input.requestKind,
          },
        },
      ),
    ),
  writeCompletion: (requestKind, request, input) =>
    writeControlRequestCompletionTo(table, requestKind, request, input),
  completionForRequest: requestId =>
    table.controlRequestCompletions.get(requestId).pipe(
      Effect.withSpan("firegrid.runtime_control_plane.control_request.completion.read", {
        kind: "consumer",
        attributes: {
          "firegrid.control.request_id": requestId,
        },
      }),
    ),
  contextRequests: table.contextRequests.query((coll) => coll.toArray).pipe(
    Effect.withSpan("firegrid.runtime_control_plane.control_request.context.query", {
      kind: "consumer",
    }),
  ),
  startRequests: table.startRequests.query((coll) => coll.toArray).pipe(
    Effect.withSpan("firegrid.runtime_control_plane.control_request.start.query", {
      kind: "consumer",
    }),
  ),
  lifecycleRequests: table.lifecycleRequests.query((coll) => coll.toArray).pipe(
    Effect.withSpan("firegrid.runtime_control_plane.control_request.lifecycle.query", {
      kind: "consumer",
    }),
  ),
  startRequestsForContext: contextId =>
    table.startRequests.query((coll) =>
      coll.toArray.filter(request => request.contextId === contextId)).pipe(
      Effect.withSpan("firegrid.runtime_control_plane.control_request.start.query_context", {
        kind: "consumer",
        attributes: {
          "firegrid.context.id": contextId,
        },
      }),
    ),
  contextRequestRows: table.contextRequests.rows().pipe(
    Stream.withSpan("firegrid.runtime_control_plane.control_request.context.rows", {
      kind: "consumer",
    }),
  ),
  startRequestRows: table.startRequests.rows().pipe(
    Stream.withSpan("firegrid.runtime_control_plane.control_request.start.rows", {
      kind: "consumer",
    }),
  ),
  lifecycleRequestRows: table.lifecycleRequests.rows().pipe(
    Stream.withSpan("firegrid.runtime_control_plane.control_request.lifecycle.rows", {
      kind: "consumer",
    }),
  ),
})

const insertLocalContextTo = (
  table: RuntimeControlPlaneTable["Type"],
  session: HostSessionRow,
  intent: RuntimeContextIntent,
  options: {
    readonly contextId: string
    readonly createdBy?: string
  },
) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap(createdAtMs =>
      makeLocalRuntimeContextForHostSession(session, intent, {
        ...options,
        createdAtMs,
      })),
    Effect.tap(context => table.contexts.upsert(context)),
    Effect.tap(context =>
      Effect.annotateCurrentSpan({
        "firegrid.context.id": context.contextId,
      })),
    Effect.withSpan("firegrid.runtime_control_plane.context.insert", {
      kind: "producer",
      attributes: {
        "firegrid.context.id": options.contextId,
      },
    }),
  )

const insertLocalContextIfAbsentTo = (
  table: RuntimeControlPlaneTable["Type"],
  session: HostSessionRow,
  intent: RuntimeContextIntent,
  options: {
    readonly contextId: string
    readonly createdBy?: string
    readonly createdAtMs?: number
  },
) =>
  Effect.gen(function* () {
    const createdAtMs = options.createdAtMs ?? (yield* Clock.currentTimeMillis)
    const runtimeContext = yield* makeLocalRuntimeContextForHostSession(
      session,
      intent,
      {
        contextId: options.contextId,
        createdAtMs,
        ...(options.createdBy === undefined ? {} : { createdBy: options.createdBy }),
      },
    )
    const result = yield* table.contexts.insertOrGet(runtimeContext)
    return result._tag === "Found" ? result.row : runtimeContext
  }).pipe(
    Effect.tap(context =>
      Effect.annotateCurrentSpan({
        "firegrid.context.id": context.contextId,
      })),
    Effect.withSpan("firegrid.runtime_control_plane.context.insert_if_absent", {
      kind: "producer",
      attributes: {
        "firegrid.context.id": options.contextId,
      },
    }),
  )

const allocateActivityAttemptTo = (
  table: RuntimeControlPlaneTable["Type"],
  context: RuntimeContext,
) =>
  table.runs.query((coll) => {
    const rows = coll.toArray.filter(row => row.contextId === context.contextId)
    const terminalAttempts = new Set(
      rows
        .filter(row => row.status === "exited" || row.status === "failed")
        .map(row => row.activityAttempt),
    )
    const inProgress = rows
      .filter(row => row.status === "started" && !terminalAttempts.has(row.activityAttempt))
      .map(row => row.activityAttempt)
      .sort((left, right) => left - right)[0]
    return inProgress ?? rows.reduce((max, row) => Math.max(max, row.activityAttempt + 1), 1)
  }).pipe(
    Effect.tap(activityAttempt =>
      Effect.annotateCurrentSpan({
        "firegrid.runtime.activity_attempt": activityAttempt,
      })),
    Effect.withSpan("firegrid.runtime_control_plane.run.allocate_attempt", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": context.contextId,
      },
    }),
  )

const upsertRunEventTo = (
  table: RuntimeControlPlaneTable["Type"],
  row: RuntimeRunEventRow,
) =>
  table.runs.upsert(row).pipe(
    Effect.withSpan("firegrid.runtime_control_plane.run.upsert_event", {
      kind: "producer",
      attributes: {
        "firegrid.context.id": row.contextId,
        "firegrid.runtime.activity_attempt": row.activityAttempt,
        "firegrid.runtime.run_status": row.status,
      },
    }),
  )

const recordStartedTo = (
  table: RuntimeControlPlaneTable["Type"],
  context: RuntimeContext,
  activityAttempt: number,
) =>
  Effect.gen(function* () {
    const startedAt = yield* authorityNowIso
    yield* upsertRunEventTo(table, {
      runEventId: {
        contextId: context.contextId,
        activityAttempt,
        status: "started",
      },
      contextId: context.contextId,
      activityAttempt,
      provider: context.runtime.provider,
      status: "started",
      at: startedAt,
    })
  })

const recordExitedTo = (
  table: RuntimeControlPlaneTable["Type"],
  context: RuntimeContext,
  activityAttempt: number,
  exit: {
    readonly exitCode: number
    readonly signal?: string | undefined
  },
) =>
  Effect.gen(function* () {
    const exitedAt = yield* authorityNowIso
    yield* upsertRunEventTo(table, {
      runEventId: {
        contextId: context.contextId,
        activityAttempt,
        status: "exited",
      },
      contextId: context.contextId,
      activityAttempt,
      status: "exited",
      provider: context.runtime.provider,
      at: exitedAt,
      exitCode: exit.exitCode,
      ...(exit.signal === undefined ? {} : { signal: exit.signal }),
    })
  })

const recordFailedTo = (
  table: RuntimeControlPlaneTable["Type"],
  context: RuntimeContext,
  activityAttempt: number,
  message: string,
) =>
  Effect.gen(function* () {
    const failedAt = yield* authorityNowIso
    yield* upsertRunEventTo(table, {
      runEventId: {
        contextId: context.contextId,
        activityAttempt,
        status: "failed",
      },
      contextId: context.contextId,
      activityAttempt,
      status: "failed",
      provider: context.runtime.provider,
      message,
      at: failedAt,
    })
  })

const runtimeContexts = (
  table: RuntimeControlPlaneTable["Type"],
): Stream.Stream<RuntimeContext, unknown> =>
  table.contexts.rows().pipe(
    Stream.withSpan("firegrid.runtime_control_plane.context.rows", {
      kind: "consumer",
    }),
  )

const runtimeRuns = (
  table: RuntimeControlPlaneTable["Type"],
): Stream.Stream<RuntimeRunEventRow, unknown> =>
  table.runs.rows().pipe(
    Stream.withSpan("firegrid.runtime_control_plane.run.rows", {
      kind: "consumer",
    }),
  )

const contextInsertFromTable = (
  table: RuntimeControlPlaneTable["Type"],
  session: HostSessionRow,
): RuntimeContextInsertService => ({
  insertLocalContext: (intent, options) =>
    insertLocalContextTo(table, session, intent, options),
  insertLocalContextIfAbsent: (intent, options) =>
    insertLocalContextIfAbsentTo(table, session, intent, options),
})

const contextReadFromTable = (
  table: RuntimeControlPlaneTable["Type"],
): RuntimeContextReadService => ({
  readContext: contextId =>
    table.contexts.get(contextId).pipe(
      Effect.withSpan("firegrid.runtime_control_plane.context.read", {
        kind: "consumer",
        attributes: {
          "firegrid.context.id": contextId,
        },
      }),
    ),
})

const localContextResolverFromTable = (
  table: RuntimeControlPlaneTable["Type"],
  session: HostSessionRow,
): RuntimeLocalContextResolverService => ({
  // firegrid-host-sdk.MCP_AND_TOOLS.4
  requireLocalContext: contextId =>
    requireLocalContext(contextId).pipe(
      Effect.provideService(RuntimeControlPlaneTable, table),
      Effect.provideService(CurrentHostSession, session),
      Effect.withSpan("firegrid.runtime_control_plane.context.require_local", {
        kind: "consumer",
        attributes: {
          "firegrid.context.id": contextId,
        },
      }),
    ),
})

const waitTerminalTo = (
  table: RuntimeControlPlaneTable["Type"],
  contextId: string,
  activityAttempt: number,
) =>
  table.runs.rows().pipe(
    Stream.filter((row) =>
      row.contextId === contextId &&
      row.activityAttempt === activityAttempt &&
      (row.status === "exited" || row.status === "failed")),
    Stream.runHead,
    Effect.withSpan("firegrid.runtime_control_plane.run.wait_terminal", {
      kind: "consumer",
      attributes: {
        "firegrid.context.id": contextId,
        "firegrid.runtime.activity_attempt": activityAttempt,
      },
    }),
  )

const latestStartedAttemptTo = (
  table: RuntimeControlPlaneTable["Type"],
  contextId: string,
) =>
  table.runs.query((coll) => {
    const startedRows = coll.toArray.filter((row) =>
      row.contextId === contextId && row.status === "started")
    if (startedRows.length === 0) return Option.none<number>()
    const max = startedRows.reduce(
      (acc, row) => row.activityAttempt > acc ? row.activityAttempt : acc,
      startedRows[0]!.activityAttempt,
    )
    return Option.some(max)
  }).pipe(
    Effect.withSpan("firegrid.runtime_control_plane.run.latest_started", {
      kind: "consumer",
      attributes: {
        "firegrid.context.id": contextId,
      },
    }),
  )

const runtimeRunAppendAndGetFromTable = (
  table: RuntimeControlPlaneTable["Type"],
): RuntimeRunAppendAndGetService => ({
  allocateActivityAttempt: context => allocateActivityAttemptTo(table, context),
  recordStarted: (context, activityAttempt) =>
    recordStartedTo(table, context, activityAttempt),
  recordExited: (context, activityAttempt, exit) =>
    recordExitedTo(table, context, activityAttempt, exit),
  latestStartedAttempt: (contextId) =>
    latestStartedAttemptTo(table, contextId),
  waitTerminal: (contextId, activityAttempt) =>
    waitTerminalTo(table, contextId, activityAttempt),
  recordFailed: (context, activityAttempt, message) =>
    recordFailedTo(
      table,
      context,
      activityAttempt,
      message,
    ),
})

export class RuntimeContextInsert extends Context.Tag(
  "@firegrid/runtime/RuntimeContextInsert",
)<RuntimeContextInsert, RuntimeContextInsertService>() {}

export class RuntimeContextRead extends Context.Tag(
  "@firegrid/runtime/RuntimeContextRead",
)<RuntimeContextRead, RuntimeContextReadService>() {}

export class RuntimeLocalContextResolver extends Context.Tag(
  "@firegrid/runtime/RuntimeLocalContextResolver",
)<RuntimeLocalContextResolver, RuntimeLocalContextResolverService>() {}

export class RuntimeRunAppendAndGet extends Context.Tag(
  "@firegrid/runtime/RuntimeRunAppendAndGet",
)<RuntimeRunAppendAndGet, RuntimeRunAppendAndGetService>() {}

export class RuntimeControlRequests extends Context.Tag(
  "@firegrid/runtime/RuntimeControlRequests",
)<RuntimeControlRequests, RuntimeControlRequestsService>() {}

export class RuntimeContexts extends Context.Tag(
  "@firegrid/runtime/RuntimeContexts",
)<RuntimeContexts, Stream.Stream<RuntimeContext, unknown>>() {}

export class RuntimeRuns extends Context.Tag(
  "@firegrid/runtime/RuntimeRuns",
)<RuntimeRuns, Stream.Stream<RuntimeRunEventRow, unknown>>() {}

export const RuntimeContextInsertLive = Layer.effect(
  RuntimeContextInsert,
  Effect.gen(function* () {
    const table = yield* RuntimeControlPlaneTable
    const session = yield* CurrentHostSession
    return contextInsertFromTable(table, session)
  }),
)

export const RuntimeControlPlaneRecorderLive = Layer.mergeAll(
  RuntimeContextInsertLive,
  Layer.effect(
    RuntimeControlRequests,
    Effect.map(RuntimeControlPlaneTable, controlRequestsFromTable),
  ),
  Layer.effect(
    RuntimeContextRead,
    Effect.map(RuntimeControlPlaneTable, contextReadFromTable),
  ),
  Layer.effect(
    RuntimeLocalContextResolver,
    Effect.gen(function* () {
      const table = yield* RuntimeControlPlaneTable
      const session = yield* CurrentHostSession
      return localContextResolverFromTable(table, session)
    }),
  ),
  Layer.effect(
    RuntimeRunAppendAndGet,
    Effect.map(RuntimeControlPlaneTable, runtimeRunAppendAndGetFromTable),
  ),
  Layer.effect(
    RuntimeContexts,
    Effect.map(RuntimeControlPlaneTable, runtimeContexts),
  ),
  Layer.effect(
    RuntimeRuns,
    Effect.map(RuntimeControlPlaneTable, runtimeRuns),
  ),
)
