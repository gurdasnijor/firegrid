import { HttpClient } from "@effect/platform"
import {
  Cause,
  Chunk,
  Duration,
  Effect,
  Option,
  Queue,
  Ref,
  Scope,
  Sink,
  Stream,
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

interface BatchAttempt {
  readonly bodyEvents: ReadonlyArray<unknown>
  readonly epoch: number
  readonly seq: number
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
          // Stale epoch / zombie-fenced.
          if (opts.autoClaim) {
            const bumped: ProducerState = { epoch: current.epoch + 1, lastSeq: -1 }
            yield* Ref.set(state, bumped)
            return yield* attempt()
          }
          return yield* Effect.die(new StaleEpoch({ currentEpoch: current.epoch }))
        }
        if (res.status === 409) {
          if (res.streamClosed) {
            return yield* Effect.fail(new StreamClosed({ finalOffset: res.nextOffset }))
          }
          // Sequence gap is an invariant violation — caller's local state is broken.
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
    // after a successful POST (or after a failed POST so flush unblocks).
    // Flush completes when `sent >= offered` — which captures the items
    // currently buffered inside `groupedWithin` that aren't visible via
    // `Queue.size`.
    const offered = yield* Ref.make(0)
    const sent = yield* Ref.make(0)

    const sendOne = (batch: Chunk.Chunk<A>): Effect.Effect<void, never, HttpClient.HttpClient> =>
      Effect.gen(function* () {
        const size = Chunk.size(batch)
        if (size === 0) return
        const result = yield* sendBatch(opts, state, encode, batch).pipe(Effect.exit)
        // Always bump `sent` so flush unblocks, even on failure (the failure
        // is captured separately).
        yield* Ref.update(sent, (n) => n + size)
        if (result._tag === "Failure") {
          yield* Ref.update(failure, (cur) =>
            Option.isSome(cur) ? cur : Option.some(extractWriteError(result.cause)),
          )
        }
      })

    // Background drain: groupedWithin batches; mapEffect runs sends with concurrency.
    yield* Stream.fromQueue(queue).pipe(
      Stream.groupedWithin(
        opts.maxBatchSize ?? 1000,
        Duration.millis(opts.lingerMs ?? 5),
      ),
      Stream.mapEffect((batch) => sendOne(batch), {
        concurrency: opts.maxInFlight ?? 5,
      }),
      Stream.runDrain,
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
      while (true) {
        const o = yield* Ref.get(offered)
        const s = yield* Ref.get(sent)
        if (s >= o) break
        yield* Effect.sleep("10 millis")
      }
      yield* checkFailure
    })

    const sink = Sink.forEach(append) as Sink.Sink<void, A, never, WriteError, never>

    const producer: Producer<A> = Object.assign(sink, {
      append,
      flush,
    }) as Producer<A>

    // Scope finalizer: drain pending events before scope releases.
    yield* Effect.addFinalizer(() =>
      flush.pipe(Effect.catchAll(() => Effect.void)),
    )

    return producer
  })
