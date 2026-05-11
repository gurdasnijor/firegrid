import type { HttpClient } from "@effect/platform"
import type {
  Brand,
  Effect,
  Schedule,
  Schema,
  Scope,
  Sink,
  Stream,
} from "effect"
import type {
  Conflict,
  Gone,
  NotFound,
  ProducerError,
  ReadError,
  TransportError,
  WriteError,
} from "./errors.ts"

// Note: error classes (Conflict / DecodeError / etc.) are exported from
// `./errors.ts` and re-exported at the package root by `./namespace.ts` —
// no duplicated re-exports here to keep knip's dead-code gate happy.

export type { ReadError, WriteError } from "./errors.ts"

export type Offset = string & Brand.Brand<"DurableStream/Offset">

export const Offset = (s: string): Offset => s as Offset

export type LiveMode = boolean | "long-poll" | "sse"

export type HeaderValue =
  | string
  | (() => string | Promise<string> | Effect.Effect<string, never, never>)

export interface HeadersRecord {
  readonly [name: string]: HeaderValue
}

/**
 * Returned by an `ErrorHandler` to retry the failed operation with merged
 * headers. Returning `undefined` (or omitting return) propagates the error.
 */
export interface RetryOpts {
  readonly headers?: HeadersRecord
}

/**
 * Hook invoked AFTER transport-level retries have exhausted. The caller
 * decides whether to retry the operation with mutated headers (typical
 * use: refresh an auth token on 401, renew a signed URL on 403). Return
 * `RetryOpts` to retry, `undefined` to propagate.
 *
 * The handler may itself fail — in that case the original error propagates
 * along with the handler failure. The handler is invoked with the original
 * error in the `unknown` slot; pattern-match on `_tag` for typed errors.
 */
export type ErrorHandler = (
  error: unknown,
) => Effect.Effect<RetryOpts | undefined | void, never, never>

export interface Endpoint {
  readonly url: string | URL
  readonly headers?: HeadersRecord
  /**
   * Optional handler invoked after transport retries exhaust. Returning
   * `RetryOpts` retries the failed operation with merged headers; returning
   * `undefined` (or omitting return) propagates the error to the caller.
   *
   * Retries via the handler are bounded by `onErrorMaxRetries` (default 4)
   * to prevent runaway loops.
   */
  readonly onError?: ErrorHandler

  /**
   * Cap on consecutive `onError` retries before the original error
   * propagates. Defaults to 4.
   */
  readonly onErrorMaxRetries?: number

  /**
   * Schedule used for transport-level retries on transient HTTP errors
   * (network failures, ECONNRESET, etc.). Defaults to exponential backoff
   * starting at 100ms with up to 4 retries, capped at 3s spacing. Pass
   * any `Effect.Schedule` for custom policy.
   */
  readonly retrySchedule?: Schedule.Schedule<unknown, unknown, never>
}

export interface HeadResult {
  readonly offset: Offset
  readonly contentType: string | undefined
  readonly streamClosed: boolean
  readonly ttlSeconds: number | undefined
  readonly expiresAt: string | undefined
  /**
   * ETag header value, if the server returns one. Pairs with `If-None-Match`
   * on subsequent catch-up reads for CDN-aware caching.
   */
  readonly etag: string | undefined
  /**
   * `Cache-Control` header value as-is, e.g. `public, max-age=60,
   * stale-while-revalidate=300`. Callers can parse for their own cache
   * policy decisions.
   */
  readonly cacheControl: string | undefined
}

export interface CreateOptions {
  readonly contentType?: string
  readonly ttlSeconds?: number
  readonly expiresAt?: string
  readonly closed?: boolean
  readonly body?: string | Uint8Array
}

export interface CloseOptions {
  readonly body?: string | Uint8Array
  readonly contentType?: string
}

export interface ProducerOptions {
  readonly producerId: string
  readonly epoch?: number
  readonly autoClaim?: boolean
  readonly lingerMs?: number
  /**
   * Soft upper bound on the count of items per HTTP batch. Default 1000.
   * The count cap interacts with `maxBatchBytes` — whichever is reached
   * first triggers the batch send.
   */
  readonly maxBatchSize?: number
  /**
   * Hard upper bound on the encoded JSON bytes per HTTP batch. Default
   * 1MiB. If a count-bounded chunk would exceed this, the batch is split
   * into sub-batches each within the cap before sending. A single event
   * larger than the cap will still be sent as its own batch.
   */
  readonly maxBatchBytes?: number
  readonly maxInFlight?: number
  /**
   * Upper bound on consecutive autoClaim epoch bumps before the producer
   * surfaces `StaleEpoch` and stops retrying. Protects against an infinite
   * loop if the server keeps returning 403 (e.g., a bug in epoch parsing,
   * a misconfigured proxy stripping the `Producer-Epoch` header). Default 16.
   */
  readonly maxAutoClaimAttempts?: number

  /**
   * Bounded capacity of the in-memory append queue. `append` backpressures
   * (suspends) when the queue is full, so callers cannot accumulate
   * unbounded work after a downstream stall. Default 10_000.
   *
   * After the first non-recoverable send failure the queue is shut down —
   * subsequent `append` calls fail immediately with the captured failure.
   */
  readonly maxQueueSize?: number
}

/**
 * A `Producer<A>` is a Sink. Use `Stream.run(events, producer)` to pour events
 * in. `append` and `flush` are convenience methods.
 *
 * On scope release: pending events flush, then the producer detaches (the
 * underlying stream stays open). Use `DurableStream.close` to terminate the
 * stream itself.
 *
 * The error channel includes `ProducerError` (`StaleEpoch` | `SequenceGap` |
 * `TransportError`) in addition to ordinary `WriteError`. A `StaleEpoch`
 * signals zombie fencing without `autoClaim` — the caller can match on it
 * and decide whether to spin a fresh producer with a higher epoch.
 * A `SequenceGap` signals the client's local lastSeq diverged from the
 * server's — typically unrecoverable, but still surfaced as a typed
 * failure rather than a defect so the caller can log and exit cleanly.
 */
export type ProducerFailure = WriteError | ProducerError

export interface Producer<A>
  extends Sink.Sink<void, A, never, ProducerFailure, never> {
  readonly append: (event: A) => Effect.Effect<void, ProducerFailure>
  readonly flush: Effect.Effect<void, ProducerFailure>
  /**
   * Bump the producer epoch and reset the local sequence counter to 0.
   * Use to take over a producer-id from a crashed peer without spinning
   * a new producer instance. The new epoch must be strictly greater than
   * the server's current epoch for the next batch to be accepted.
   */
  readonly restart: (epoch: number) => Effect.Effect<void, never>
}

export interface ReadOpts<A, I> {
  readonly endpoint: Endpoint
  readonly schema: Schema.Schema<A, I>
  readonly offset?: Offset
  readonly live?: LiveMode
  /**
   * If supplied with `live: false`, the catch-up read sends `If-None-Match`
   * on the FIRST request. A 304 response short-circuits the stream (it
   * completes without emitting items). Use with the `etag` returned from
   * a prior `head()` to cheaply check for new data behind a CDN.
   */
  readonly ifNoneMatch?: string
}

export interface CollectOpts<A, I> {
  readonly endpoint: Endpoint
  readonly schema: Schema.Schema<A, I>
}

export interface AppendOpts<A, I> {
  readonly endpoint: Endpoint
  readonly schema: Schema.Schema<A, I>
  readonly event: A
  readonly seq?: string
}

export interface ProducerMakeOpts<A, I> extends ProducerOptions {
  readonly endpoint: Endpoint
  readonly schema: Schema.Schema<A, I>
}

export interface SnapshotResult<A> {
  readonly snapshot: ReadonlyArray<A>
  readonly live: Stream.Stream<A, ReadError, HttpClient.HttpClient>
}

/**
 * Curried form: bind endpoint + schema once, then call methods. All `R`
 * channels include `HttpClient.HttpClient` — provide `FetchHttpClient.layer`
 * once at the top of your program.
 */
export interface Bound<A, I> {
  readonly endpoint: Endpoint
  readonly schema: Schema.Schema<A, I>
  readonly read: (
    opts?: { readonly live?: LiveMode; readonly offset?: Offset },
  ) => Stream.Stream<A, ReadError, HttpClient.HttpClient>
  readonly collect: Effect.Effect<ReadonlyArray<A>, ReadError, HttpClient.HttpClient>
  readonly snapshotThenFollow: Effect.Effect<
    SnapshotResult<A>,
    ReadError,
    HttpClient.HttpClient
  >
  readonly append: (
    event: A,
    opts?: { readonly seq?: string },
  ) => Effect.Effect<{ readonly offset: Offset }, WriteError, HttpClient.HttpClient>
  readonly producer: (
    opts: ProducerOptions,
  ) => Effect.Effect<
    Producer<A>,
    TransportError,
    HttpClient.HttpClient | Scope.Scope
  >
  readonly head: Effect.Effect<
    HeadResult,
    TransportError | NotFound | Gone,
    HttpClient.HttpClient
  >
  readonly create: (
    opts?: CreateOptions,
  ) => Effect.Effect<void, TransportError | Conflict, HttpClient.HttpClient>
  readonly close: (
    opts?: CloseOptions,
  ) => Effect.Effect<{ readonly finalOffset: Offset }, WriteError, HttpClient.HttpClient>
  readonly delete: Effect.Effect<void, TransportError | NotFound, HttpClient.HttpClient>
}
