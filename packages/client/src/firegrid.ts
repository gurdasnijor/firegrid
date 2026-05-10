import {
  readRetainedJson,
} from "@firegrid/durable-streams/log"
import {
  createDurableStateDb,
  runtimeContextStateSchema,
} from "@firegrid/durable-streams/state"
import {
  PublicLaunchRequestSchema,
  RuntimeJournalEventSchema,
  local,
  normalizeRuntimeIntent,
  type PublicLaunchRequest,
  type RuntimeContext,
  type RuntimeEvent,
  type RuntimeJournalEvent,
  type RuntimeLogLine,
  type RuntimeRunEvent,
} from "@firegrid/protocol/launch"
import { Context, Data, Effect, Layer, Schema, Stream } from "effect"

export interface ClientOptions {
  readonly runtimeStreamUrl: string
  readonly controlPlaneStreamUrl?: string
  readonly dataPlaneStreamUrl?: string
  readonly contentType?: string
  readonly txTimeoutMs?: number
}

export class FiregridConfig extends Context.Tag("@firegrid/client/FiregridConfig")<
  FiregridConfig,
  ClientOptions
>() {}

export class PreloadError extends Data.TaggedError("PreloadError")<{
  readonly cause: unknown
}> {}

export class AppendError extends Data.TaggedError("AppendError")<{
  readonly contextId: string
  readonly cause: unknown
}> {}

export class LaunchInputError extends Data.TaggedError("LaunchInputError")<{
  readonly cause: unknown
}> {}

export type FiregridError = PreloadError | LaunchInputError | AppendError

export interface RuntimeContextSnapshot {
  readonly contextId: string
  readonly context?: RuntimeContext
  readonly status?: RuntimeRunEvent["status"]
  readonly runs: ReadonlyArray<RuntimeRunEvent>
  readonly events: ReadonlyArray<RuntimeEvent>
  readonly logs: ReadonlyArray<RuntimeLogLine>
}

export interface RuntimeContextHandle {
  readonly contextId: string
  readonly snapshot: Effect.Effect<RuntimeContextSnapshot, PreloadError>
  readonly changes: Stream.Stream<RuntimeContextSnapshot, PreloadError>
}

export interface FiregridService {
  readonly launch: (request: PublicLaunchRequest) => Effect.Effect<RuntimeContextHandle, LaunchInputError | AppendError>
  readonly open: (contextId: string) => RuntimeContextHandle
}

export class Firegrid extends Context.Tag("@firegrid/client/Firegrid")<
  Firegrid,
  FiregridService
>() {}

export { local }

const latestStatus = (
  events: ReadonlyArray<RuntimeRunEvent>,
): RuntimeRunEvent["status"] | undefined =>
  [...events].sort((left, right) => left.at.localeCompare(right.at)).at(-1)?.status

const compareJournalRows = (
  left: { readonly activityAttempt: number; readonly sequence: number },
  right: { readonly activityAttempt: number; readonly sequence: number },
): number =>
  left.activityAttempt - right.activityAttempt || left.sequence - right.sequence

const makeContextId = (): string => `ctx_${crypto.randomUUID()}`

const normalizeLaunch = (request: PublicLaunchRequest): RuntimeContext => ({
  // firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.3
  // firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.7
  contextId: makeContextId(),
  createdAt: new Date().toISOString(),
  ...(request.requestedBy === undefined ? {} : { createdBy: request.requestedBy }),
  runtime: normalizeRuntimeIntent(request.runtime),
})

const decodePublicLaunchRequest = (
  request: PublicLaunchRequest,
): Effect.Effect<PublicLaunchRequest, LaunchInputError> =>
  Schema.decodeUnknown(PublicLaunchRequestSchema, { onExcessProperty: "error" })(request).pipe(
    Effect.mapError(cause => new LaunchInputError({ cause })),
  )

const decodeJournalEvent = (
  value: unknown,
): RuntimeJournalEvent =>
  Schema.decodeUnknownSync(RuntimeJournalEventSchema)(value)

const snapshotFromJournal = (
  contextId: string,
  control: {
    readonly context?: RuntimeContext
    readonly runs: ReadonlyArray<RuntimeRunEvent>
  },
  journal: ReadonlyArray<RuntimeJournalEvent>,
): RuntimeContextSnapshot => {
  const events = journal
    .flatMap(event => event.type === "firegrid.runtime.output.stdout" ? [event.event] : [])
    .filter(row => row.contextId === contextId)
    .sort(compareJournalRows)
  const logs = journal
    .flatMap(event => event.type === "firegrid.runtime.output.stderr" ? [event.log] : [])
    .filter(row => row.contextId === contextId)
    .sort(compareJournalRows)
  const runs = [...control.runs].sort((left, right) => left.at.localeCompare(right.at))
  const status = latestStatus(runs)
  return {
    contextId,
    ...(control.context === undefined ? {} : { context: control.context }),
    ...(status === undefined ? {} : { status }),
    runs,
    events,
    logs,
  }
}

const make = Effect.gen(function* () {
  const cfg = yield* FiregridConfig
  const controlPlaneStreamUrl = cfg.controlPlaneStreamUrl ?? cfg.runtimeStreamUrl
  const dataPlaneStreamUrl = cfg.dataPlaneStreamUrl
  const txTimeoutMs = cfg.txTimeoutMs ?? 2_000
  const db = createDurableStateDb({
    streamOptions: {
      url: controlPlaneStreamUrl,
      contentType: cfg.contentType ?? "application/json",
    },
    state: runtimeContextStateSchema,
    actions: ({ db, stream }) => ({
      appendContext: {
        onMutate: (context: RuntimeContext) => {
          if (db.collections.contexts.get(context.contextId) === undefined) {
            db.collections.contexts.insert(context)
          }
        },
        mutationFn: async (context: RuntimeContext) => {
          const txid = `firegrid-client-context:${context.contextId}`
          await stream.append(JSON.stringify(runtimeContextStateSchema.contexts.upsert({
            value: context,
            headers: { txid },
          })))
          await db.utils.awaitTxId(txid, txTimeoutMs)
        },
      },
    }),
  })

  yield* Effect.tryPromise({
    try: () => db.preload(),
    catch: cause => new PreloadError({ cause }),
  }).pipe(Effect.asVoid)
  yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

  const readJournal = (): Effect.Effect<ReadonlyArray<RuntimeJournalEvent>, PreloadError> =>
    dataPlaneStreamUrl === undefined
      ? Effect.succeed([])
      : readRetainedJson<unknown>({ streamUrl: dataPlaneStreamUrl }).pipe(
        Effect.map(values => values.map(decodeJournalEvent)),
        Effect.mapError(cause => new PreloadError({ cause })),
      )

  const appendContext = (context: RuntimeContext): Effect.Effect<void, AppendError> =>
    Effect.tryPromise({
      try: async () => {
        await db.actions.appendContext(context).isPersisted.promise
      },
      catch: cause => new AppendError({ contextId: context.contextId, cause }),
    })

  const readSnapshot = (
    contextId: string,
  ): Effect.Effect<RuntimeContextSnapshot, PreloadError> =>
    readJournal().pipe(
      Effect.map(journal => {
        const context = db.collections.contexts.get(contextId)
        return snapshotFromJournal(contextId, {
          ...(context === undefined ? {} : { context }),
          runs: Array.from(db.collections.runs.state.values() as Iterable<RuntimeRunEvent>)
            .filter(row => row.contextId === contextId),
        }, journal)
      }),
    )

  const open = (contextId: string): RuntimeContextHandle => ({
    contextId,
    snapshot: readSnapshot(contextId),
    changes: Stream.fromEffect(readSnapshot(contextId)),
  })

  return Firegrid.of({
    launch: request => Effect.gen(function* () {
      // firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.1
      // firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.6
      const decoded = yield* decodePublicLaunchRequest(request)
      const normalized = normalizeLaunch(decoded)
      yield* appendContext(normalized)
      return open(normalized.contextId)
    }),
    open,
  })
})

export const FiregridLive = Layer.scoped(Firegrid, make)
