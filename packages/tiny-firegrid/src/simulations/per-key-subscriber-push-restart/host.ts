import type { FiregridHost } from "@firegrid/runtime/composition/host-live"
import { Effect, Layer, Option, Stream } from "effect"
import {
  eventKeyFor,
  initialState,
  now,
  PerKeyTable,
  perKeyTableOptions,
  type PerKeyTableService,
  type StateRow,
} from "./resources.ts"
import {
  makeInstrumentation,
  resetInstrumentation,
  runSubscriber,
  snapshotMetrics,
  type Instrumentation,
  type MetricsSnapshot,
  type Rendezvous,
  type SubscriberMode,
} from "./subscriber.ts"
import type { TinyFiregridHostEnv } from "../../types.ts"

export interface PerKeySubscriberRuntime {
  // Producer side: append a durable event fact for a key. Idempotent by
  // eventKey. NOTE: appending NEVER signals a subscriber — the only wakeup is
  // the substrate tail. (That is the "no write+arm" invariant.)
  readonly appendEvent: (event: {
    readonly contextId: string
    readonly sequence: number
    readonly value: number
  }) => Effect.Effect<void, unknown>
  // Wait until a key's durable cursor reaches `sequence` — via the native
  // state.rows() tail, not polling.
  readonly waitUntilProcessed: (
    contextId: string,
    sequence: number,
  ) => Effect.Effect<StateRow, unknown>
  // Read the current durable state rows for the given keys.
  readonly snapshotStates: (
    contextIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<StateRow>, unknown>
  // Run one subscriber GENERATION over the shared durable log. A fresh table
  // layer is built over the same stream url (faithful process restart: in-memory
  // state dropped, durable rows persist). The subscriber is forked into the
  // generation scope; `program` drives/asserts; when it returns the scope closes
  // = crash.
  readonly runGeneration: <A>(
    mode: SubscriberMode,
    ownsContext: (contextId: string) => boolean,
    program: Effect.Effect<A, unknown>,
    rendezvous?: Rendezvous,
  ) => Effect.Effect<A, unknown>
  readonly metrics: Effect.Effect<MetricsSnapshot>
  readonly resetMetrics: Effect.Effect<void>
}

const runtimeLatch = (() => {
  let resolveRuntime: (runtime: PerKeySubscriberRuntime) => void = () => undefined
  const promise = new Promise<PerKeySubscriberRuntime>((resolve) => {
    resolveRuntime = resolve
  })
  return { promise, resolve: resolveRuntime }
})()

export const perKeySubscriberRuntime = runtimeLatch.promise

const appendEvent = (
  producer: PerKeyTableService,
  event: { readonly contextId: string; readonly sequence: number; readonly value: number },
): Effect.Effect<void, unknown> =>
  producer.events.insertOrGet({
    eventKey: eventKeyFor(event.contextId, event.sequence),
    contextId: event.contextId,
    sequence: event.sequence,
    value: event.value,
    appendedAt: now(),
  }).pipe(
    Effect.asVoid,
    Effect.withSpan("firegrid.tf4fy3.producer.append_event", {
      kind: "producer",
      attributes: {
        "firegrid.tf4fy3.context_id": event.contextId,
        "firegrid.tf4fy3.sequence": event.sequence,
        "firegrid-workflow-driven-runtime.ACID":
          "PHASE_0_TARGET_REFERENCE.3",
      },
    }),
  )

const waitUntilProcessed = (
  producer: PerKeyTableService,
  contextId: string,
  sequence: number,
): Effect.Effect<StateRow, unknown> =>
  Effect.gen(function*() {
    const current = yield* producer.state.get(contextId)
    if (Option.isSome(current) && current.value.lastProcessedSequence >= sequence) {
      return current.value
    }
    const matched = yield* producer.state.rows().pipe(
      Stream.filter(row =>
        row.contextId === contextId && row.lastProcessedSequence >= sequence),
      Stream.runHead,
    )
    return yield* Option.match(matched, {
      onNone: () =>
        Effect.fail(new Error(
          `state stream ended before ${contextId} reached sequence ${sequence}`,
        )),
      onSome: row => Effect.succeed(row),
    })
  }).pipe(
    Effect.withSpan("firegrid.tf4fy3.producer.wait_until_processed", {
      kind: "consumer",
      attributes: {
        "firegrid.tf4fy3.context_id": contextId,
        "firegrid.tf4fy3.sequence": sequence,
        "firegrid-workflow-driven-runtime.ACID": "BOUNDARIES.7-1",
      },
    }),
  )

const snapshotStates = (
  producer: PerKeyTableService,
  contextIds: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<StateRow>, unknown> =>
  Effect.forEach(contextIds, contextId =>
    producer.state.get(contextId).pipe(
      Effect.map(Option.getOrElse(() => initialState(contextId))),
    ))

const runGeneration = (
  env: TinyFiregridHostEnv,
  instrumentation: Instrumentation,
) =>
<A>(
  mode: SubscriberMode,
  ownsContext: (contextId: string) => boolean,
  program: Effect.Effect<A, unknown>,
  rendezvous?: Rendezvous,
): Effect.Effect<A, unknown> => {
  const subscriberLayer = PerKeyTable.layer(perKeyTableOptions(env))
  return Effect.scoped(
    Effect.gen(function*() {
      const subscriberTable = yield* PerKeyTable
      yield* runSubscriber(
        subscriberTable, instrumentation, mode, ownsContext, rendezvous,
      ).pipe(
        Effect.forkScoped,
      )
      return yield* program
    }).pipe(
      Effect.provide(subscriberLayer as Layer.Layer<PerKeyTable, never, never>),
    ),
  ) as Effect.Effect<A, unknown>
}

const runtimeFor = (
  env: TinyFiregridHostEnv,
  producer: PerKeyTableService,
  instrumentation: Instrumentation,
): PerKeySubscriberRuntime => ({
  appendEvent: event => appendEvent(producer, event),
  waitUntilProcessed: (contextId, sequence) =>
    waitUntilProcessed(producer, contextId, sequence),
  snapshotStates: contextIds => snapshotStates(producer, contextIds),
  runGeneration: runGeneration(env, instrumentation),
  metrics: snapshotMetrics(instrumentation),
  resetMetrics: resetInstrumentation(instrumentation),
})

export const perKeySubscriberHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown, never> => {
  const producerLayer = PerKeyTable.layer(perKeyTableOptions(env))
  const wiringLayer = Layer.scopedDiscard(
    Effect.gen(function*() {
      const producer = yield* PerKeyTable
      const instrumentation = yield* makeInstrumentation
      runtimeLatch.resolve(runtimeFor(env, producer, instrumentation))
    }),
  )
  return wiringLayer.pipe(
    Layer.provide(producerLayer),
  ) as Layer.Layer<FiregridHost, unknown, never>
}
