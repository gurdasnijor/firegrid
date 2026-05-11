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
import type { ProducerError, WriteError } from "../errors.ts"
import { encodeUnsafe } from "../internal/schema.ts"
import * as Http from "./Http.ts"

interface ProducerState {
  readonly epoch: number
  readonly lastSeq: number
}

type AnyProducerFailure = WriteError | ProducerError

/**
 * Reduce a Cause from a batch send to a single typed failure. Failures
 * (Effect.fail) are surfaced as-is. Defects (Effect.die with a known
 * ProducerError) are unwrapped to their typed form rather than being
 * squashed into TransportError — callers can match on the tag and decide
 * whether the producer is recoverable. Truly unexpected defects still
 * become TransportError.
 */
const extractFailure = (
  cause: Cause.Cause<AnyProducerFailure>,
): AnyProducerFailure => {
  const fail = Cause.failureOption(cause)
  if (Option.isSome(fail)) return fail.value
  const defect = Cause.dieOption(cause)
  if (Option.isSome(defect)) {
    const d = defect.value
    if (d instanceof StaleEpoch) return d
    if (d instanceof SequenceGap) return d
    return new TransportError({ cause: d })
  }
  return new TransportError({ cause: Cause.squash(cause) })
}

const sendBatch = <A, I>(
  opts: ProducerMakeOpts<A, I>,
  state: Ref.Ref<ProducerState>,
  encode: (event: A) => I,
  batch: Chunk.Chunk<A>,
): Effect.Effect<void, AnyProducerFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (Chunk.size(batch) === 0) return
    const encoded = Chunk.toReadonlyArray(batch).map((event) => encode(event))
    const body = JSON.stringify(encoded)

    const maxAutoClaim = opts.maxAutoClaimAttempts ?? 16

    const attempt = (
      autoClaimsSoFar: number,
    ): Effect.Effect<void, AnyProducerFailure, HttpClient.HttpClient> =>
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
          if (opts.autoClaim && autoClaimsSoFar < maxAutoClaim) {
            const serverEpoch = res.producerEpoch ?? current.epoch
            const bumped: ProducerState = { epoch: serverEpoch + 1, lastSeq: -1 }
            yield* Ref.set(state, bumped)
            return yield* attempt(autoClaimsSoFar + 1)
          }
          // Either autoClaim is off, OR we've burned through the cap (which
          // typically means the server keeps returning 403 — bug, proxy
          // stripping the epoch header, or genuine contention). Surface as
          // a typed failure so the caller can decide what to do.
          return yield* Effect.fail(
            new StaleEpoch({ currentEpoch: res.producerEpoch ?? current.epoch }),
          )
        }
        if (res.status === 409) {
          if (res.streamClosed) {
            return yield* Effect.fail(new StreamClosed({ finalOffset: res.nextOffset }))
          }
          // §5.2.1 invariant violation: client's local lastSeq diverged from
          // the server's. Surface as a typed failure — the caller cannot
          // recover, but it learns what went wrong.
          return yield* Effect.fail(
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

    yield* attempt(0)
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
    const queue = yield* Queue.bounded<A>(opts.maxQueueSize ?? 10_000)
    const failure = yield* Ref.make<Option.Option<AnyProducerFailure>>(Option.none())
    // `offered` increments on every append; `sent` increments by batch size
    // after a POST completes (success OR failure — the failure is captured
    // separately). Flush is event-driven on `sent.changes` so it wakes up
    // exactly when a batch acks, without fixed polling.
    const offered = yield* Ref.make(0)
    const sent = yield* SubscriptionRef.make(0)

    const maxBatchBytes = opts.maxBatchBytes ?? 1_048_576 // 1 MiB

    /**
     * Slice a count-bounded batch into sub-batches each within
     * `maxBatchBytes`. A single item larger than the cap is sent as its
     * own sub-batch (and may exceed the cap). Each sub-batch gets its own
     * producer-seq through the existing `attempt()` chain.
     */
    const splitByBytes = (items: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> => {
      if (items.length === 0) return []
      const out: Array<Array<A>> = []
      let cur: Array<A> = []
      let curBytes = 2 // `[` + `]` overhead
      for (const item of items) {
        // Approx per-item bytes by re-encoding through the schema. This is
        // double work — sendBatch will encode again — but it's bounded and
        // happens only at batch-emission time, not per-event.
        const itemBytes = Buffer.byteLength(JSON.stringify(encode(item)), "utf8") + 1 // `,`
        if (cur.length > 0 && curBytes + itemBytes > maxBatchBytes) {
          out.push(cur)
          cur = []
          curBytes = 2
        }
        cur.push(item)
        curBytes += itemBytes
      }
      if (cur.length > 0) out.push(cur)
      return out
    }

    const sendOne = (batch: Chunk.Chunk<A>): Effect.Effect<void, never, HttpClient.HttpClient> =>
      Effect.gen(function* () {
        if (Chunk.size(batch) === 0) return
        const subBatches = splitByBytes(Chunk.toReadonlyArray(batch))
        for (const sub of subBatches) {
          const subChunk = Chunk.unsafeFromArray(sub.slice())
          const result = yield* sendBatch(opts, state, encode, subChunk).pipe(Effect.exit)
          yield* SubscriptionRef.update(sent, (n) => n + sub.length)
          if (result._tag === "Failure") {
            yield* Ref.update(failure, (cur) =>
              Option.isSome(cur) ? cur : Option.some(extractFailure(result.cause)),
            )
            // Stop sending further sub-batches; the background drain loop
            // will no-op subsequent batches (still draining the queue so
            // backpressured offers wake and observe the typed failure).
            return
          }
        }
      })

    // Background drain — eager-emission loop.
    //
    // `Stream.groupedWithin(maxBatch, lingerMs)` waits the FULL `lingerMs`
    // every window, even when items are already queued at the moment the
    // window opens. For a burst (500 events appended in tight succession)
    // that means we pay a `lingerMs` tax we don't need: the first batch
    // could have been sent immediately.
    //
    // The eager loop:
    //   1. `Queue.take`         — suspend until at least one event is queued.
    //   2. `Queue.takeUpTo(...)` — synchronously drain whatever else is
    //                              already there, up to `maxBatch - 1`.
    //   3. If we caught a burst (more than just the trigger event), send
    //      now — no idle wait. Otherwise (sparse trickle), wait `lingerMs`
    //      to coalesce stragglers, then send.
    //
    // Sends remain serialized to preserve producer-seq ordering — safe
    // concurrent pipelining (`maxInFlight > 1`) requires per-(epoch, seq)
    // state with 409 retry, left as a follow-up.
    //
    // After a terminal failure is recorded, the drain keeps reading and
    // no-ops the batches (still advancing `sent` so `flush` exits and
    // backpressured `append` fibers wake to observe the typed failure).
    const maxBatch = opts.maxBatchSize ?? 1000
    const lingerMs = opts.lingerMs ?? 5

    const drainOnce: Effect.Effect<void, never, HttpClient.HttpClient> = Effect.gen(function* () {
      const first = yield* Queue.take(queue)
      const tail = yield* Queue.takeUpTo(queue, maxBatch - 1)
      let batch: ReadonlyArray<A> = [first, ...Chunk.toReadonlyArray(tail)]
      // Skip the linger if either:
      //   - The batch is already FULL (maxBatch reached — no room to grow).
      //     Notably: `maxBatch === 1` is always full at this point, so we
      //     never linger on a count-1 producer.
      //   - We caught a BURST (more than just the trigger event was queued).
      //     Bursts are evidence of a tight writer; further coalescing would
      //     only add tail latency without improving throughput.
      // Linger only when the trigger event arrived alone AND we have room
      // to coalesce more.
      const isFull = batch.length >= maxBatch
      const isBurst = batch.length > 1
      if (!isFull && !isBurst && lingerMs > 0) {
        yield* Effect.sleep(Duration.millis(lingerMs))
        const stragglers = yield* Queue.takeUpTo(queue, maxBatch - 1)
        if (Chunk.size(stragglers) > 0) {
          batch = [...batch, ...Chunk.toReadonlyArray(stragglers)]
        }
      }
      const chunk = Chunk.unsafeFromArray(batch.slice())
      const f = yield* Ref.get(failure)
      if (Option.isSome(f)) {
        yield* SubscriptionRef.update(sent, (n) => n + batch.length)
        return
      }
      yield* sendOne(chunk)
    })

    yield* drainOnce.pipe(Effect.forever, Effect.forkScoped)

    const checkFailure: Effect.Effect<void, AnyProducerFailure> = Ref.get(failure).pipe(
      Effect.flatMap((opt) => Option.isSome(opt) ? Effect.fail(opt.value) : Effect.void),
    )

    const append = (event: A): Effect.Effect<void, AnyProducerFailure> =>
      Effect.gen(function* () {
        // Fast-fail: the queue is bounded, so a stalled drain backpressures
        // here. Without this gate, `append` would suspend on a full queue
        // after a terminal failure had already been recorded.
        yield* checkFailure
        yield* Queue.offer(queue, event)
        // Re-check: failure may have been recorded between the entry gate
        // and the offer (or during a backpressured wait). In that case the
        // event will be dropped by the no-op drain, so surface the typed
        // failure rather than letting the caller think the append landed.
        yield* checkFailure
        yield* Ref.update(offered, (n) => n + 1)
      })

    const flush: Effect.Effect<void, AnyProducerFailure> = Effect.gen(function* () {
      // Drive off `sent.changes` — the stream emits the current value first,
      // then every update. The predicate also fires when a terminal failure
      // is recorded, otherwise events offered but never sent (because the
      // queue was shut down on failure) would leave `sent < offered`
      // forever. `checkFailure` after the loop surfaces the typed failure.
      yield* sent.changes.pipe(
        Stream.takeUntilEffect((s) =>
          Effect.gen(function* () {
            const f = yield* Ref.get(failure)
            if (Option.isSome(f)) return true
            const o = yield* Ref.get(offered)
            return s >= o
          }),
        ),
        Stream.runDrain,
      )
      yield* checkFailure
    })

    const restart = (epoch: number): Effect.Effect<void, never> =>
      Ref.set(state, { epoch, lastSeq: -1 })

    const sink = Sink.forEach(append)

    const producer: Producer<A> = Object.assign(sink, {
      append,
      flush,
      restart,
    })

    // Scope finalizer: best-effort drain of pending events before the scope
    // releases. Callers who require durability must `flush` explicitly at
    // semantic boundaries — this hook only catches the common case of a
    // tidy shutdown with nothing in flight. Any failure surfaced here is
    // logged at warning so silent data loss is at least observable.
    yield* Effect.addFinalizer(() =>
      flush.pipe(
        Effect.catchAllCause((cause) =>
          Effect.logWarning("effect-durable-streams: producer finalizer flush failed", cause),
        ),
      ),
    )

    return producer
  })
