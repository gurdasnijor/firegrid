import {
  CurrentHostSession,
  RuntimeControlPlaneTable,
  makeLocalRuntimeContextForHostSession,
  type HostSessionRow,
  type RuntimeContext,
  type RuntimeContextIntent,
  type RuntimeRunEventRow,
} from "@firegrid/protocol/launch"
import { Clock, Context, Effect, Layer, Stream } from "effect"
import type { Option } from "effect"
import { authorityNowIso } from "./time.ts"

export interface RuntimeContextInsertService {
  readonly insertLocalContext: (
    intent: RuntimeContextIntent,
    options: {
      readonly contextId: string
      readonly createdBy?: string
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
