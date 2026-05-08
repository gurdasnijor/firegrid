import { createStreamDB } from "@durable-streams/state"
import {
  runtimeLaunchStateSchema,
  type RuntimeLaunchRequest,
  type RuntimeProcessEvent,
  type StreamPlaneRef,
} from "@firegrid/protocol/launch"
import { Context, Data, Effect, Layer, Stream } from "effect"

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

export class StopError extends Data.TaggedError("StopError")<{
  readonly launchId: string
  readonly reason: string
}> {}

export type FiregridError = PreloadError | AppendError | StopError

export interface LaunchSnapshot {
  readonly launchId: string
  readonly request?: RuntimeLaunchRequest
  readonly status?: RuntimeProcessEvent["status"]
  readonly runtimeProcesses: ReadonlyArray<RuntimeProcessEvent>
}

export interface LaunchHandle {
  readonly launchId: string
  readonly snapshot: Effect.Effect<LaunchSnapshot>
  readonly changes: Stream.Stream<LaunchSnapshot>
  readonly stop: Effect.Effect<void, StopError>
  readonly diagnosticStream: (name: string) => Effect.Effect<StreamPlaneRef | undefined>
}

export interface FiregridService {
  readonly launch: (request: RuntimeLaunchRequest) => Effect.Effect<LaunchHandle, AppendError>
  readonly open: (launchId: string) => LaunchHandle
}

export class Firegrid extends Context.Tag("@firegrid/client/Firegrid")<
  Firegrid,
  FiregridService
>() {}

const latestStatus = (
  events: ReadonlyArray<RuntimeProcessEvent>,
): RuntimeProcessEvent["status"] | undefined =>
  [...events].sort((left, right) => left.at.localeCompare(right.at)).at(-1)?.status

const preload = (
  db: { readonly preload: () => Promise<unknown> },
): Effect.Effect<void, PreloadError> =>
  Effect.tryPromise({
    try: () => db.preload(),
    catch: cause => new PreloadError({ cause }),
  }).pipe(Effect.asVoid)

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
    const runtimeProcesses = Array.from(db.collections.runtimeProcesses.state.values() as Iterable<RuntimeProcessEvent>)
      .filter(event => event.launchId === launchId)
      .sort((left, right) => left.at.localeCompare(right.at))
    const status = latestStatus(runtimeProcesses)
    return {
      launchId,
      ...(request === undefined ? {} : { request }),
      ...(status === undefined ? {} : { status }),
      runtimeProcesses,
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
          const runtimeProcesses = db.collections.runtimeProcesses.subscribeChanges(push)
          return () => {
            launches.unsubscribe()
            runtimeProcesses.unsubscribe()
          }
        }),
        cleanup => Effect.sync(cleanup),
      ), { bufferSize: 16, strategy: "sliding" }),
    stop: Effect.suspend(() =>
      Effect.fail(new StopError({
        launchId,
        reason: "launch stop rows are not implemented yet",
      })),
    ),
    diagnosticStream: name =>
      Effect.sync(() => {
        const current = readSnapshot(launchId)
        return current.request?.planes.diagnostics?.[name] ?? current.request?.planes.session[name]
      }),
  })

  const appendLaunchRequest = (request: RuntimeLaunchRequest): Effect.Effect<void, AppendError> =>
    Effect.tryPromise({
      try: async () => {
        await db.actions.appendLaunchRequest(request).isPersisted.promise
      },
      catch: cause => new AppendError({ launchId: request.launchId, cause }),
    })

  return Firegrid.of({
    launch: request =>
      // firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.1
      appendLaunchRequest(request).pipe(Effect.as(open(request.launchId))),
    open,
  })
})

export const FiregridLive = Layer.scoped(Firegrid, make)
