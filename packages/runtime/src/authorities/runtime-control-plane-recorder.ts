import {
  CurrentHostSession,
  RuntimeControlPlaneTable,
  makeLocalRuntimeContextForHostSession,
  type HostSessionRow,
  type RuntimeContext,
  type RuntimeContextIntent,
  type RuntimeRunEventRow,
} from "@firegrid/protocol/launch"
import { Clock, Context, Effect, Layer } from "effect"
import {
  type RuntimeAuthority,
  type RuntimeAuthorityCommand,
  type RuntimeAuthorityRead,
} from "../events/index.ts"
import { sourceCollectionHandle } from "../waits/internal/source-collections.ts"
import { RuntimeAuthoritySourceNames } from "./source-names.ts"
import { authorityNowIso } from "./time.ts"

interface RuntimeControlPlaneInsertLocalContextRequest {
  readonly session: HostSessionRow
  readonly intent: RuntimeContextIntent
  readonly contextId: string
  readonly createdBy?: string
}

interface RuntimeControlPlaneRecordStartedRequest {
  readonly context: RuntimeContext
  readonly activityAttempt: number
}

interface RuntimeControlPlaneRecordExitedRequest {
  readonly context: RuntimeContext
  readonly activityAttempt: number
  readonly exit: {
    readonly exitCode: number
    readonly signal?: string | undefined
  }
}

interface RuntimeControlPlaneRecordFailedRequest {
  readonly context: RuntimeContext
  readonly activityAttempt: number
  readonly message: string
}

interface RuntimeControlPlaneWrites {
  readonly insertLocalContext: RuntimeAuthorityCommand<
    RuntimeControlPlaneInsertLocalContextRequest,
    RuntimeContext,
    unknown
  >
  readonly recordStarted: RuntimeAuthorityCommand<RuntimeControlPlaneRecordStartedRequest, void, unknown>
  readonly recordExited: RuntimeAuthorityCommand<RuntimeControlPlaneRecordExitedRequest, void, unknown>
  readonly recordFailed: RuntimeAuthorityCommand<RuntimeControlPlaneRecordFailedRequest, void, unknown>
}

interface RuntimeControlPlaneReads {
  readonly contexts: RuntimeAuthorityRead
  readonly runs: RuntimeAuthorityRead
}

type RuntimeControlPlaneAuthorityService = RuntimeAuthority<
  RuntimeControlPlaneWrites,
  RuntimeControlPlaneReads
>

class RuntimeControlPlaneAuthority extends Context.Tag(
  "@firegrid/runtime/RuntimeControlPlaneAuthority",
)<RuntimeControlPlaneAuthority, RuntimeControlPlaneAuthorityService>() {}

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
  )

export const insertLocalContext = (
  intent: RuntimeContextIntent,
  options: {
    readonly contextId: string
    readonly createdBy?: string
  },
) =>
  Effect.flatMap(RuntimeControlPlaneTable, table =>
    Effect.flatMap(CurrentHostSession, session =>
      insertLocalContextTo(table, session, intent, options)))

const readContext = (
  contextId: string,
) =>
  Effect.gen(function* () {
    const table = yield* RuntimeControlPlaneTable
    return yield* table.contexts.get(contextId)
  })

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
  })

const allocateActivityAttempt = (
  context: RuntimeContext,
) =>
  Effect.flatMap(RuntimeControlPlaneTable, table =>
    allocateActivityAttemptTo(table, context))

const upsertRunEventTo = (
  table: RuntimeControlPlaneTable["Type"],
  row: RuntimeRunEventRow,
) => table.runs.upsert(row)

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

const recordStarted = (
  context: RuntimeContext,
  activityAttempt: number,
) =>
  Effect.flatMap(RuntimeControlPlaneTable, table =>
    recordStartedTo(table, context, activityAttempt))

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

const recordExited = (
  context: RuntimeContext,
  activityAttempt: number,
  exit: {
    readonly exitCode: number
    readonly signal?: string | undefined
  },
) =>
  Effect.flatMap(RuntimeControlPlaneTable, table =>
    recordExitedTo(table, context, activityAttempt, exit))

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

const recordFailed = (
  context: RuntimeContext,
  activityAttempt: number,
  message: string,
) =>
  Effect.flatMap(RuntimeControlPlaneTable, table =>
    recordFailedTo(table, context, activityAttempt, message))

const sources = (
  table: RuntimeControlPlaneTable["Type"],
) => ({
  contexts: sourceCollectionHandle(
    RuntimeAuthoritySourceNames.runtimeContexts,
    table.contexts,
  ),
  runs: sourceCollectionHandle(
    RuntimeAuthoritySourceNames.runtimeRuns,
    table.runs,
  ),
}) as const

const authority = (
  table: RuntimeControlPlaneTable["Type"],
): RuntimeControlPlaneAuthorityService => ({
  write: {
    insertLocalContext: request =>
      insertLocalContextTo(table, request.session, request.intent, {
        contextId: request.contextId,
        ...(request.createdBy === undefined ? {} : { createdBy: request.createdBy }),
      }),
    recordStarted: request =>
      recordStartedTo(table, request.context, request.activityAttempt),
    recordExited: request =>
      recordExitedTo(table, request.context, request.activityAttempt, request.exit),
    recordFailed: request =>
      recordFailedTo(
        table,
        request.context,
        request.activityAttempt,
        request.message,
      ),
  },
  read: sources(table),
})

const layer = Layer.effect(
  RuntimeControlPlaneAuthority,
  Effect.map(RuntimeControlPlaneTable, authority),
)

export const RuntimeControlPlaneRecorder = {
  authority,
  layer,
  insertLocalContext,
  insertLocalContextTo,
  readContext,
  allocateActivityAttempt,
  allocateActivityAttemptTo,
  recordStarted,
  recordStartedTo,
  recordExited,
  recordExitedTo,
  recordFailed,
  recordFailedTo,
  sources,
} as const
