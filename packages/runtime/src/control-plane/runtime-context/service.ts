import {
  createDurableStateDb,
  runtimeContextStateSchema,
} from "@firegrid/durable-streams"
import {
  type RuntimeContext,
  type RuntimeRunEvent,
} from "@firegrid/protocol/launch"
import { Context, Duration, Effect, Layer, Option, Schema } from "effect"
import {
  asRuntimeContextError,
  type RuntimeContextError,
} from "./errors.ts"
import {
  runEventId,
  runId,
} from "./ids.ts"

interface RuntimeControlPlaneOptions {
  readonly streamUrl: string
  readonly contentType?: string
  readonly txTimeout?: Duration.DurationInput
}

class RuntimeControlPlaneError extends Schema.TaggedError<RuntimeControlPlaneError>()(
  "RuntimeControlPlaneError",
  {
    op: Schema.String,
    contextId: Schema.optional(Schema.String),
    cause: Schema.Unknown,
  },
) {}

type RuntimeRunStatusParams = {
  readonly contextId: string
  readonly activityAttempt: number
  readonly provider: RuntimeContext["runtime"]["provider"]
}

interface RuntimeControlPlaneService {
  readonly appendContext: (
    context: RuntimeContext,
  ) => Effect.Effect<void, RuntimeControlPlaneError>
  readonly appendRunStarted: (
    params: RuntimeRunStatusParams,
  ) => Effect.Effect<void, RuntimeContextError>
  readonly appendRunExited: (
    params: RuntimeRunStatusParams & {
      readonly exitCode: number
      readonly signal?: string
    },
  ) => Effect.Effect<void, RuntimeContextError>
  readonly appendRunFailed: (
    params: RuntimeRunStatusParams & {
      readonly message: string
    },
  ) => Effect.Effect<void, RuntimeContextError>
  readonly getContext: (contextId: string) => Option.Option<RuntimeContext>
  readonly runsFor: (contextId: string) => ReadonlyArray<RuntimeRunEvent>
}

export class RuntimeControlPlane extends Context.Tag("firegrid/runtime/RuntimeControlPlane")<
  RuntimeControlPlane,
  RuntimeControlPlaneService
>() {}

type ActionResult = {
  readonly isPersisted: {
    readonly promise: Promise<unknown>
  }
}

type MutableCollection<Row> = {
  readonly get: (id: string) => Row | undefined
  readonly insert: (row: Row) => void
}

type UpsertEventBuilder<Row> = {
  readonly upsert: (options: {
    readonly value: Row
    readonly headers: { readonly txid: string }
  }) => unknown
}

const nowIso = (): string => new Date().toISOString()

const runtimeRunEvent = (
  params: RuntimeRunStatusParams & {
    readonly status: RuntimeRunEvent["status"]
    readonly exitCode?: number
    readonly signal?: string
    readonly message?: string
  },
): RuntimeRunEvent => ({
  runEventId: runEventId(params.contextId, params.activityAttempt, params.status),
  runId: runId(params.contextId, params.activityAttempt),
  contextId: params.contextId,
  activityAttempt: params.activityAttempt,
  status: params.status,
  at: nowIso(),
  provider: params.provider,
  ...(params.exitCode === undefined ? {} : { exitCode: params.exitCode }),
  ...(params.signal === undefined ? {} : { signal: params.signal }),
  ...(params.message === undefined ? {} : { message: params.message }),
})

const persistAction = <A extends ActionResult>(
  op: string,
  contextId: string | undefined,
  action: () => A,
): Effect.Effect<void, RuntimeControlPlaneError> =>
  Effect.tryPromise({
    try: async () => {
      await action().isPersisted.promise
    },
    catch: cause => new RuntimeControlPlaneError({
      op,
      ...(contextId === undefined ? {} : { contextId }),
      cause,
    }),
  })

const promiseOp = <A>(
  op: string,
  promise: () => Promise<A>,
): Effect.Effect<A, RuntimeControlPlaneError> =>
  Effect.tryPromise({
    try: promise,
    catch: cause => new RuntimeControlPlaneError({ op, cause }),
  })

const mapRunWriteError = (
  op: string,
  contextId: string,
) =>
  Effect.mapError((cause: RuntimeControlPlaneError) =>
    asRuntimeContextError(op, "failed to append runtime control-plane row", contextId, cause))

const makeRuntimeControlPlaneDb = (
  options: RuntimeControlPlaneOptions,
) => {
  const txTimeoutMs = Duration.toMillis(Duration.decode(options.txTimeout ?? "2 seconds"))
  return createDurableStateDb({
    streamOptions: {
      url: options.streamUrl,
      contentType: options.contentType ?? "application/json",
    },
    state: runtimeContextStateSchema,
    actions: ({ db, stream }) => {
      const appendStateEvent = async (
        txid: string,
        event: unknown,
      ) => {
        await stream.append(JSON.stringify(event))
        await db.utils.awaitTxId(txid, txTimeoutMs)
      }
      const stateAction = <Row>(
        collection: MutableCollection<Row>,
        eventBuilder: UpsertEventBuilder<Row>,
        rowId: (row: Row) => string,
        txidFor: (row: Row) => string = rowId,
      ) => ({
        onMutate: (row: Row) => {
          const id = rowId(row)
          if (collection.get(id) === undefined) {
            collection.insert(row)
          }
        },
        mutationFn: (row: Row) => {
          const txid = txidFor(row)
          return appendStateEvent(txid, eventBuilder.upsert({
            value: row,
            headers: { txid },
          }))
        },
      })
      return {
        appendContext: stateAction(
          db.collections.contexts,
          runtimeContextStateSchema.contexts,
          (context: RuntimeContext) => context.contextId,
          context => `firegrid-context:${context.contextId}`,
        ),
        appendRunEvent: stateAction(
          db.collections.runs,
          runtimeContextStateSchema.runs,
          (event: RuntimeRunEvent) => event.runEventId,
        ),
      }
    },
  })
}

export const RuntimeControlPlaneLive = (
  options: RuntimeControlPlaneOptions,
) =>
  Layer.scoped(
    RuntimeControlPlane,
    Effect.gen(function* () {
      const db = makeRuntimeControlPlaneDb(options)
      yield* promiseOp("preload", () => db.preload())
      yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

      const appendRunEvent = (
        event: RuntimeRunEvent,
      ): Effect.Effect<void, RuntimeControlPlaneError> =>
        persistAction("appendRunEvent", event.contextId, () =>
          db.actions.appendRunEvent(event))

      return RuntimeControlPlane.of({
        appendContext: context =>
          persistAction("appendContext", context.contextId, () =>
            db.actions.appendContext(context)),
        appendRunStarted: params =>
          appendRunEvent(runtimeRunEvent({ ...params, status: "started" })).pipe(
            mapRunWriteError("run.started", params.contextId),
          ),
        appendRunExited: params =>
          appendRunEvent(runtimeRunEvent({ ...params, status: "exited" })).pipe(
            mapRunWriteError("run.exited", params.contextId),
          ),
        appendRunFailed: params =>
          appendRunEvent(runtimeRunEvent({ ...params, status: "failed" })).pipe(
            mapRunWriteError("run.failed", params.contextId),
          ),
        getContext: contextId =>
          Option.fromNullable(db.collections.contexts.get(contextId)),
        runsFor: contextId =>
          Array.from(db.collections.runs.state.values() as Iterable<RuntimeRunEvent>)
            .filter(event => event.contextId === contextId),
      })
    }),
  )
