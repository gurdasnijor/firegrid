import { createStreamDB } from "@durable-streams/state"
import {
  runtimeLaunchStateSchema,
  type DiagnosticRow,
  type ProviderWireRow,
  type RuntimeLaunchRequest,
  type RuntimeProcessEvent,
} from "@firegrid/protocol/launch"
import { Context, Duration, Effect, Layer, Option, Schema } from "effect"

interface RuntimeLaunchDbOptions {
  readonly streamUrl: string
  readonly contentType?: string
  readonly txTimeout?: Duration.DurationInput
}

export class RuntimeLaunchDbError extends Schema.TaggedError<RuntimeLaunchDbError>()(
  "RuntimeLaunchDbError",
  {
    op: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export interface RuntimeLaunchDbService {
  readonly appendLaunchRequest: (
    request: RuntimeLaunchRequest,
  ) => Effect.Effect<void, RuntimeLaunchDbError>
  readonly appendProcessEvent: (
    event: RuntimeProcessEvent,
  ) => Effect.Effect<void, RuntimeLaunchDbError>
  readonly appendProviderWireRow: (
    row: ProviderWireRow,
  ) => Effect.Effect<void, RuntimeLaunchDbError>
  readonly appendDiagnosticRow: (
    row: DiagnosticRow,
  ) => Effect.Effect<void, RuntimeLaunchDbError>
  readonly getLaunchRequest: (launchId: string) => Option.Option<RuntimeLaunchRequest>
  readonly processEventsFor: (launchId: string) => ReadonlyArray<RuntimeProcessEvent>
  readonly providerWireFor: (launchId: string) => ReadonlyArray<ProviderWireRow>
  readonly diagnosticsFor: (launchId: string) => ReadonlyArray<DiagnosticRow>
}

export class RuntimeLaunchDb extends Context.Tag("firegrid/runtime/RuntimeLaunchDb")<
  RuntimeLaunchDb,
  RuntimeLaunchDbService
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

const persistAction = <A extends ActionResult>(
  op: string,
  action: () => A,
): Effect.Effect<void, RuntimeLaunchDbError> =>
  Effect.tryPromise({
    try: async () => {
      await action().isPersisted.promise
    },
    catch: cause => new RuntimeLaunchDbError({ op, cause }),
  })

const promiseOp = <A>(
  op: string,
  promise: () => Promise<A>,
): Effect.Effect<A, RuntimeLaunchDbError> =>
  Effect.tryPromise({
    try: promise,
    catch: cause => new RuntimeLaunchDbError({ op, cause }),
  })

const makeRuntimeLaunchStreamDb = (
  options: RuntimeLaunchDbOptions,
) => {
  const txTimeoutMs = Duration.toMillis(Duration.decode(options.txTimeout ?? "2 seconds"))
  return createStreamDB({
    streamOptions: {
      url: options.streamUrl,
      contentType: options.contentType ?? "application/json",
    },
    state: runtimeLaunchStateSchema,
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
        appendLaunchRequest: stateAction(
          db.collections.launchRequests,
          runtimeLaunchStateSchema.launchRequests,
          (request: RuntimeLaunchRequest) => request.launchId,
          request => `firegrid-launch:${request.launchId}`,
        ),
        appendProcessEvent: stateAction(
          db.collections.processEvents,
          runtimeLaunchStateSchema.processEvents,
          (event: RuntimeProcessEvent) => event.processEventId,
        ),
        appendProviderWireRow: stateAction(
          db.collections.providerWire,
          runtimeLaunchStateSchema.providerWire,
          (row: ProviderWireRow) => row.providerWireRowId,
        ),
        appendDiagnosticRow: stateAction(
          db.collections.diagnostics,
          runtimeLaunchStateSchema.diagnostics,
          (row: DiagnosticRow) => row.diagnosticRowId,
        ),
      }
    },
  })
}

export const RuntimeLaunchDbLive = (
  options: RuntimeLaunchDbOptions,
) =>
  Layer.scoped(
    RuntimeLaunchDb,
    Effect.gen(function* () {
      const db = makeRuntimeLaunchStreamDb(options)
      yield* promiseOp("preload", () => db.preload())
      yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

      return RuntimeLaunchDb.of({
        appendLaunchRequest: request =>
          persistAction("appendLaunchRequest", () =>
            db.actions.appendLaunchRequest(request)),
        appendProcessEvent: event =>
          persistAction("appendProcessEvent", () =>
            db.actions.appendProcessEvent(event)),
        appendProviderWireRow: row =>
          persistAction("appendProviderWireRow", () =>
            db.actions.appendProviderWireRow(row)),
        appendDiagnosticRow: row =>
          persistAction("appendDiagnosticRow", () =>
            db.actions.appendDiagnosticRow(row)),
        getLaunchRequest: launchId =>
          Option.fromNullable(db.collections.launchRequests.get(launchId)),
        processEventsFor: launchId =>
          Array.from(db.collections.processEvents.state.values() as Iterable<RuntimeProcessEvent>)
            .filter(event => event.launchId === launchId),
        providerWireFor: launchId =>
          Array.from(db.collections.providerWire.state.values() as Iterable<ProviderWireRow>)
            .filter(row => row.launchId === launchId),
        diagnosticsFor: launchId =>
          Array.from(db.collections.diagnostics.state.values() as Iterable<DiagnosticRow>)
            .filter(row => row.launchId === launchId),
      })
    }),
  )
