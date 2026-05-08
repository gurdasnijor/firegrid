import { createStreamDB } from "@durable-streams/state"
import {
  runtimeLaunchStateSchema,
  type RuntimeLaunchRequest,
  type RuntimeProcessEvent,
  type StreamPlaneRef,
} from "@firegrid/protocol/launch"
import type { Scope } from "effect"
import { Effect, Schema } from "effect"

export interface ClientOptions {
  readonly launchStreamUrl: string
  readonly contentType?: string
  readonly txTimeoutMs?: number
}

export class ClientError extends Schema.TaggedError<ClientError>()(
  "FiregridClientError",
  {
    op: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export interface LaunchSnapshot {
  readonly launchId: string
  readonly request?: RuntimeLaunchRequest
  readonly status?: RuntimeProcessEvent["status"]
  readonly runtimeProcesses: ReadonlyArray<RuntimeProcessEvent>
}

export interface LaunchHandle {
  readonly launchId: string
  readonly snapshot: Effect.Effect<LaunchSnapshot, ClientError>
  readonly lifecycle: Effect.Effect<LaunchSnapshot, ClientError>
  readonly stop: Effect.Effect<void, ClientError>
  readonly diagnostic: {
    readonly stream: (name: string) => Effect.Effect<StreamPlaneRef | undefined, ClientError>
  }
}

export interface Client {
  readonly launch: (request: RuntimeLaunchRequest) => Effect.Effect<LaunchHandle, ClientError>
  readonly openLaunch: (launchId: string) => LaunchHandle
  readonly close: Effect.Effect<void>
}

const promiseOp = <A>(
  op: string,
  promise: () => Promise<A>,
): Effect.Effect<A, ClientError> =>
  Effect.tryPromise({
    try: promise,
    catch: cause => new ClientError({ op, cause }),
  })

const latestStatus = (
  events: ReadonlyArray<RuntimeProcessEvent>,
): RuntimeProcessEvent["status"] | undefined =>
  [...events].sort((left, right) => left.at.localeCompare(right.at)).at(-1)?.status

export const make = (
  options: ClientOptions,
): Effect.Effect<Client, ClientError> =>
  Effect.gen(function* () {
    const txTimeoutMs = options.txTimeoutMs ?? 2_000
    const db = createStreamDB({
      streamOptions: {
        url: options.launchStreamUrl,
        contentType: options.contentType ?? "application/json",
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

    yield* promiseOp("preload", () => db.preload())

    const snapshot = (launchId: string): Effect.Effect<LaunchSnapshot, ClientError> =>
      Effect.gen(function* () {
        yield* promiseOp("preload", () => db.preload())
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
      })

    const openLaunch = (launchId: string): LaunchHandle => ({
      launchId,
      snapshot: snapshot(launchId),
      lifecycle: snapshot(launchId),
      stop: Effect.fail(new ClientError({
        op: "stop",
        cause: "launch stop rows are not implemented yet",
      })),
      diagnostic: {
        stream: name =>
          Effect.gen(function* () {
            const current = yield* snapshot(launchId)
            return current.request?.planes.diagnostics?.[name] ?? current.request?.planes.session[name]
          }),
      },
    })

    return {
      launch: request =>
        Effect.gen(function* () {
          // firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.1
          yield* promiseOp("appendLaunchRequest", async () => {
            await db.actions.appendLaunchRequest(request).isPersisted.promise
          })
          return openLaunch(request.launchId)
        }),
      openLaunch,
      close: Effect.sync(() => db.close()),
    }
  })

export const scoped = (
  options: ClientOptions,
): Effect.Effect<Client, ClientError, Scope.Scope> =>
  Effect.acquireRelease(
    make(options),
    client => client.close,
  )
