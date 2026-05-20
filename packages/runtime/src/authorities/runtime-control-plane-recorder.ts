import {
  CurrentHostSession,
  RuntimeControlPlaneTable,
  makeLocalRuntimeContextForHostSession,
  makeRuntimeControlRequestCompletionRow,
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
import { Clock, Context, Effect, Layer, Stream } from "effect"
import type { Option } from "effect"
import { authorityNowIso } from "./time.ts"

type RuntimeControlRequestRow =
  | RuntimeContextRequestRow
  | RuntimeStartRequestRow
  | RuntimeLifecycleRequestRow

export interface RuntimeControlRequestCompletionInput {
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
  readonly recordFailed: (
    context: RuntimeContext,
    activityAttempt: number,
    message: string,
  ) => Effect.Effect<void, unknown>
}

export interface RuntimeControlRequestsService {
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

const runtimeRunAppendAndGetFromTable = (
  table: RuntimeControlPlaneTable["Type"],
): RuntimeRunAppendAndGetService => ({
  allocateActivityAttempt: context => allocateActivityAttemptTo(table, context),
  recordStarted: (context, activityAttempt) =>
    recordStartedTo(table, context, activityAttempt),
  recordExited: (context, activityAttempt, exit) =>
    recordExitedTo(table, context, activityAttempt, exit),
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
