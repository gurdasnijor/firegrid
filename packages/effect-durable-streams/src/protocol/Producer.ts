import { type HttpClient } from "@effect/platform"
import {
  Cause,
  Chunk,
  Duration,
  Effect,
  Option,
  Queue,
  Ref,
  type Scope,
  Sink,
  Stream,
  SubscriptionRef,
} from "effect"
import type { Producer, ProducerMakeOpts } from "../DurableStream.ts"
import {
  Conflict,
  NotFound,
  SequenceGap,
  StaleEpoch,
  StreamClosed,
  TransportError,
} from "../errors.ts"
import type { WriteError } from "../errors.ts"
import { encodeUnsafe } from "../internal/schema.ts"
import * as Http from "./Http.ts"

interface ProducerState {
  readonly epoch: number
  readonly lastSeq: number
}

const extractWriteError = (cause: Cause.Cause<WriteError>): WriteError => {
  const fail = Cause.failureOption(cause)
  if (Option.isSome(fail)) return fail.value
  // Defects (StaleEpoch/SequenceGap) shouldn't reach here, but fall through
  // safely so the producer doesn't hang.
  return new TransportError({ cause: Cause.squash(cause) })
}

const sendBatch = <A, I>(
  opts: ProducerMakeOpts<A, I>,
  state: Ref.Ref<ProducerState>,
  encode: (event: A) => I,
  batch: Chunk.Chunk<A>,
): Effect.Effect<void, WriteError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (Chunk.size(batch) === 0) return
    const encoded = Chunk.toReadonlyArray(batch).map((event) => encode(event))
    const body = JSON.stringify(encoded)

    const attempt = (): Effect.Effect<void, WriteError, HttpClient.HttpClient> =>
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        const nextSeq = current.lastSeq + 1
        const res = yield* Http.post(opts.endpoint, {
          body,
          producerId: opts.producerId,
          producerEpoch: current.epoch,
          producerSeq: nextSeq,
        })
        // §5.2.1 — server response interpretation:
        if (res.status === 200 || res.status === 204) {
          // New (200) or duplicate (204) success. Advance only on ack.
          yield* Ref.update(state, (s): ProducerState => ({ epoch: s.epoch, lastSeq: nextSeq }))
          if (res.streamClosed) {
            return yield* Effect.fail(new StreamClosed({ finalOffset: res.nextOffset }))
          }
          return
        }
        if (res.status === 403) {
          // Stale epoch / zombie-fenced. Per §5.2.1 the server returns its
          // current epoch in the `Producer-Epoch` response header — jump
          // straight past it so autoClaim converges in O(1) round-trips.
          if (opts.autoClaim) {
            const serverEpoch = res.producerEpoch ?? current.epoch
            const bumped: ProducerState = { epoch: serverEpoch + 1, lastSeq: -1 }
            yield* Ref.set(state, bumped)
            return yield* attempt()
          }
          // eslint-disable-next-line no-restricted-syntax -- §5.2.1 invariant violation: caller has a stale epoch and no autoClaim. Recovering at this layer is impossible; surface as a defect so the host can decide.
          return yield* Effect.die(
            new StaleEpoch({ currentEpoch: res.producerEpoch ?? current.epoch }),
          )
        }
        if (res.status === 409) {
          if (res.streamClosed) {
            return yield* Effect.fail(new StreamClosed({ finalOffset: res.nextOffset }))
          }
          // eslint-disable-next-line no-restricted-syntax -- §5.2.1 invariant violation: client's local lastSeq diverged from the server's. Treat as a defect — flush/append cannot recover, the host decides.
          return yield* Effect.die(
            new SequenceGap({
              expectedSeq: res.producerExpectedSeq ?? -1,
              receivedSeq: res.producerReceivedSeq ?? nextSeq,
            }),
          )
        }
        if (res.status === 404) {
          return yield* Effect.fail(new NotFound({ url: String(opts.endpoint.url) }))
        }
        if (res.status === 400) {
          return yield* Effect.fail(
            new Conflict({ reason: `400 Bad Request from producer epoch=${current.epoch} seq=${nextSeq}` }),
          )
        }
        return yield* Effect.fail(
          new TransportError({ cause: new Error(`POST returned status ${res.status}`) }),
        )
      })

    yield* attempt()
  })

export const make = <A, I>(
  opts: ProducerMakeOpts<A, I>,
): Effect.Effect<Producer<A>, TransportError, HttpClient.HttpClient | Scope.Scope> =>
  Effect.gen(function* () {
    const encode = encodeUnsafe(opts.schema)
    const state = yield* Ref.make<ProducerState>({
      epoch: opts.epoch ?? 0,
      lastSeq: -1,
    })
    const queue = yield* Queue.unbounded<A>()
    const failure = yield* Ref.make<Option.Option<WriteError>>(Option.none())
    // `offered` increments on every append; `sent` increments by batch size
    // after a POST completes (success OR failure — the failure is captured
    // separately). Flush is event-driven on `sent.changes` so it wakes up
    // exactly when a batch acks, without fixed polling.
    const offered = yield* Ref.make(0)
    const sent = yield* SubscriptionRef.make(0)

    const sendOne = (batch: Chunk.Chunk<A>): Effect.Effect<void, never, HttpClient.HttpClient> =>
      Effect.gen(function* () {
        const size = Chunk.size(batch)
        if (size === 0) return
        const result = yield* sendBatch(opts, state, encode, batch).pipe(Effect.exit)
        yield* SubscriptionRef.update(sent, (n) => n + size)
        if (result._tag === "Failure") {
          yield* Ref.update(failure, (cur) =>
            Option.isSome(cur) ? cur : Option.some(extractWriteError(result.cause)),
          )
        }
      })

    // Background drain: groupedWithin batches; sends are serialized to
    // preserve producer-seq ordering. Per §5.2.1, the server validates seqs
    // monotonically; safe concurrent pipelining requires per-batch state
    // tracking with retry on out-of-order 409s — left as a follow-up.
    yield* Stream.fromQueue(queue).pipe(
      Stream.groupedWithin(
        opts.maxBatchSize ?? 1000,
        Duration.millis(opts.lingerMs ?? 5),
      ),
      Stream.runForEach((batch) => sendOne(batch)),
      Effect.forkScoped,
    )

    const checkFailure: Effect.Effect<void, WriteError> = Ref.get(failure).pipe(
      Effect.flatMap((opt) => Option.isSome(opt) ? Effect.fail(opt.value) : Effect.void),
    )

    const append = (event: A): Effect.Effect<void, WriteError> =>
      Effect.gen(function* () {
        yield* checkFailure
        yield* Queue.offer(queue, event)
        yield* Ref.update(offered, (n) => n + 1)
      })

    const flush: Effect.Effect<void, WriteError> = Effect.gen(function* () {
      // Drive off `sent.changes` — the stream emits the current value first,
      // then every update. `takeUntilEffect` exits the loop the first time
      // sent has caught up to (or surpassed) the current offered count.
      yield* sent.changes.pipe(
        Stream.takeUntilEffect((s) =>
          Effect.map(Ref.get(offered), (o) => s >= o),
        ),
        Stream.runDrain,
      )
      yield* checkFailure
    })

    const sink = Sink.forEach(append)

    const producer: Producer<A> = Object.assign(sink, {
      append,
      flush,
    })

    // Scope finalizer: drain pending events before scope releases.
    yield* Effect.addFinalizer(() =>
      flush.pipe(Effect.catchAll(() => Effect.void)),
    )

    return producer
  })
