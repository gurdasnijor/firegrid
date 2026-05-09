import { createStreamDB } from "@durable-streams/state"
import {
  PublicLaunchRequestSchema,
  runtimeLaunchStateSchema,
  local,
  normalizeRuntimeIntent,
  type DiagnosticRow,
  type ProviderWireRow,
  type PublicLaunchRequest,
  type RuntimeLaunchRequest,
  type RuntimeProcessEvent,
} from "@firegrid/protocol/launch"
import { Context, Data, Effect, Layer, Schema, Stream } from "effect"

export interface ClientOptions {
  readonly launchStreamUrl: string
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
  readonly launchId: string
  readonly cause: unknown
}> {}

export class LaunchInputError extends Data.TaggedError("LaunchInputError")<{
  readonly cause: unknown
}> {}

export type FiregridError = PreloadError | LaunchInputError | AppendError

export interface LaunchSnapshot {
  readonly launchId: string
  readonly request?: RuntimeLaunchRequest
  readonly status?: RuntimeProcessEvent["status"]
  readonly processEvents: ReadonlyArray<RuntimeProcessEvent>
  readonly providerWire: ReadonlyArray<ProviderWireRow>
  readonly diagnostics: ReadonlyArray<DiagnosticRow>
}

export interface LaunchHandle {
  readonly launchId: string
  readonly snapshot: Effect.Effect<LaunchSnapshot>
  readonly changes: Stream.Stream<LaunchSnapshot>
}

export interface FiregridService {
  readonly launch: (request: PublicLaunchRequest) => Effect.Effect<LaunchHandle, LaunchInputError | AppendError>
  readonly open: (launchId: string) => LaunchHandle
}

export class Firegrid extends Context.Tag("@firegrid/client/Firegrid")<
  Firegrid,
  FiregridService
>() {}

export { local }

const latestStatus = (
  events: ReadonlyArray<RuntimeProcessEvent>,
): RuntimeProcessEvent["status"] | undefined =>
  [...events].sort((left, right) => left.at.localeCompare(right.at)).at(-1)?.status

const compareJournalRows = (
  left: { readonly activityAttempt: number; readonly sequence: number },
  right: { readonly activityAttempt: number; readonly sequence: number },
): number =>
  left.activityAttempt - right.activityAttempt || left.sequence - right.sequence

const preload = (
  db: { readonly preload: () => Promise<unknown> },
): Effect.Effect<void, PreloadError> =>
  Effect.tryPromise({
    try: () => db.preload(),
    catch: cause => new PreloadError({ cause }),
  }).pipe(Effect.asVoid)

const makeLaunchId = (): string => `launch_${crypto.randomUUID()}`

const normalizeLaunch = (request: PublicLaunchRequest): RuntimeLaunchRequest => ({
  // firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.3
  // firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.7
  launchId: makeLaunchId(),
  requestedAt: new Date().toISOString(),
  ...(request.requestedBy === undefined ? {} : { requestedBy: request.requestedBy }),
  runtime: normalizeRuntimeIntent(request.runtime),
})

const decodePublicLaunchRequest = (
  request: PublicLaunchRequest,
): Effect.Effect<PublicLaunchRequest, LaunchInputError> =>
  Schema.decodeUnknown(PublicLaunchRequestSchema, { onExcessProperty: "error" })(request).pipe(
    Effect.mapError(cause => new LaunchInputError({ cause })),
  )

const make = Effect.gen(function* () {
  const cfg = yield* FiregridConfig
  const txTimeoutMs = cfg.txTimeoutMs ?? 2_000
  const db = createStreamDB({
    streamOptions: {
      url: cfg.launchStreamUrl,
      contentType: cfg.contentType ?? "application/json",
    },
    state: runtimeLaunchStateSchema,
    actions: ({ db, stream }) => ({
      appendLaunchRequest: {
        onMutate: (request: RuntimeLaunchRequest) => {
          if (db.collections.launchRequests.get(request.launchId) === undefined) {
            db.collections.launchRequests.insert(request)
          }
        },
        mutationFn: async (request: RuntimeLaunchRequest) => {
          const txid = `firegrid-client-launch:${request.launchId}`
          await stream.append(JSON.stringify(runtimeLaunchStateSchema.launchRequests.upsert({
            value: request,
            headers: { txid },
          })))
          await db.utils.awaitTxId(txid, txTimeoutMs)
        },
      },
    }),
  })

  yield* preload(db)
  yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

  const readSnapshot = (launchId: string): LaunchSnapshot => {
    const request = db.collections.launchRequests.get(launchId)
    const processEvents = Array.from(db.collections.processEvents.state.values() as Iterable<RuntimeProcessEvent>)
      .filter(event => event.launchId === launchId)
      .sort((left, right) => left.at.localeCompare(right.at))
    const providerWire = Array.from(db.collections.providerWire.state.values() as Iterable<ProviderWireRow>)
      .filter(row => row.launchId === launchId)
      .sort(compareJournalRows)
    const diagnostics = Array.from(db.collections.diagnostics.state.values() as Iterable<DiagnosticRow>)
      .filter(row => row.launchId === launchId)
      .sort(compareJournalRows)
    const status = latestStatus(processEvents)
    return {
      launchId,
      ...(request === undefined ? {} : { request }),
      ...(status === undefined ? {} : { status }),
      processEvents,
      providerWire,
      diagnostics,
    }
  }

  const open = (launchId: string): LaunchHandle => ({
    launchId,
    snapshot: Effect.sync(() => readSnapshot(launchId)),
    changes: Stream.asyncPush<LaunchSnapshot>(emit =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const push = () => {
            emit.single(readSnapshot(launchId))
          }
          push()
          const launches = db.collections.launchRequests.subscribeChanges(push)
          const processEvents = db.collections.processEvents.subscribeChanges(push)
          const providerWire = db.collections.providerWire.subscribeChanges(push)
          const diagnostics = db.collections.diagnostics.subscribeChanges(push)
          return () => {
            launches.unsubscribe()
            processEvents.unsubscribe()
            providerWire.unsubscribe()
            diagnostics.unsubscribe()
          }
        }),
        cleanup => Effect.sync(cleanup),
      ), { bufferSize: 16, strategy: "sliding" }),
  })

  const appendLaunchRequest = (request: RuntimeLaunchRequest): Effect.Effect<void, AppendError> =>
    Effect.tryPromise({
      try: async () => {
        await db.actions.appendLaunchRequest(request).isPersisted.promise
      },
      catch: cause => new AppendError({ launchId: request.launchId, cause }),
    })

  return Firegrid.of({
    launch: request => Effect.gen(function* () {
      // firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.1
      // firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.6
      const decoded = yield* decodePublicLaunchRequest(request)
      const normalized = normalizeLaunch(decoded)
      yield* appendLaunchRequest(normalized)
      return open(normalized.launchId)
    }),
    open,
  })
})

export const FiregridLive = Layer.scoped(Firegrid, make)
