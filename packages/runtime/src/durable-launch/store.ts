import { createStreamDB } from "@durable-streams/state"
import {
  runtimeLaunchStateSchema,
  type RuntimeLaunchRequest,
  type RuntimeProcessEvent,
} from "@firegrid/protocol/launch"
import type { Scope } from "effect"
import { Effect, Schema } from "effect"

interface RuntimeLaunchStoreOptions {
  readonly streamUrl: string
  readonly contentType?: string
  readonly txTimeoutMs?: number
}

export class RuntimeLaunchStoreError extends Schema.TaggedError<RuntimeLaunchStoreError>()(
  "RuntimeLaunchStoreError",
  {
    op: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export interface RuntimeLaunchStore {
  readonly getLaunchRequest: (launchId: string) => RuntimeLaunchRequest | undefined
  readonly runtimeProcessEvents: () => ReadonlyArray<RuntimeProcessEvent>
  readonly appendLaunchRequest: (request: RuntimeLaunchRequest) => Effect.Effect<void, RuntimeLaunchStoreError>
  readonly appendRuntimeProcessEvent: (event: RuntimeProcessEvent) => Effect.Effect<void, RuntimeLaunchStoreError>
  readonly preload: Effect.Effect<void, RuntimeLaunchStoreError>
  readonly close: Effect.Effect<void>
}

const promiseOp = <A>(
  op: string,
  promise: () => Promise<A>,
): Effect.Effect<A, RuntimeLaunchStoreError> =>
  Effect.tryPromise({
    try: promise,
    catch: cause => new RuntimeLaunchStoreError({ op, cause }),
  })

export const makeRuntimeLaunchStore = (
  options: RuntimeLaunchStoreOptions,
): Effect.Effect<RuntimeLaunchStore, RuntimeLaunchStoreError> =>
  Effect.gen(function* () {
    const txTimeoutMs = options.txTimeoutMs ?? 2_000
    const db = createStreamDB({
      streamOptions: {
        url: options.streamUrl,
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
            const txid = `firegrid-launch:${request.launchId}`
            await stream.append(JSON.stringify(runtimeLaunchStateSchema.launchRequests.upsert({
              value: request,
              headers: { txid },
            })))
            await db.utils.awaitTxId(txid, txTimeoutMs)
          },
        },
        appendRuntimeProcessEvent: {
          onMutate: (event: RuntimeProcessEvent) => {
            if (db.collections.runtimeProcesses.get(event.processEventId) === undefined) {
              db.collections.runtimeProcesses.insert(event)
            }
          },
          mutationFn: async (event: RuntimeProcessEvent) => {
            const txid = event.processEventId
            await stream.append(JSON.stringify(runtimeLaunchStateSchema.runtimeProcesses.insert({
              value: event,
              headers: { txid },
            })))
            await db.utils.awaitTxId(txid, txTimeoutMs)
          },
        },
      }),
    })

    yield* promiseOp("preload", () => db.preload())

    return {
      getLaunchRequest: launchId => db.collections.launchRequests.get(launchId),
      runtimeProcessEvents: () => Array.from(db.collections.runtimeProcesses.state.values()),
      appendLaunchRequest: request =>
        promiseOp("appendLaunchRequest", async () => {
          await db.actions.appendLaunchRequest(request).isPersisted.promise
        }),
      appendRuntimeProcessEvent: event =>
        promiseOp("appendRuntimeProcessEvent", async () => {
          await db.actions.appendRuntimeProcessEvent(event).isPersisted.promise
        }),
      preload: promiseOp("preload", () => db.preload()),
      close: Effect.sync(() => db.close()),
    }
  })

export const acquireRuntimeLaunchStore = (
  options: RuntimeLaunchStoreOptions,
): Effect.Effect<RuntimeLaunchStore, RuntimeLaunchStoreError, Scope.Scope> =>
  Effect.acquireRelease(
    makeRuntimeLaunchStore(options),
    store => store.close,
  )
