import { HttpClient } from "@effect/platform"
import { Chunk, Effect, Stream } from "effect"
import type {
  CollectOpts,
  Endpoint,
  HeadResult,
  ReadOpts,
  SnapshotResult,
} from "./DurableStream.ts"
import type { Gone, NotFound, ReadError, TransportError } from "./errors.ts"
import * as Http from "./protocol/Http.ts"
import { BEGIN, readStream } from "./protocol/Read.ts"

export const read = <A, I>(
  opts: ReadOpts<A, I>,
): Stream.Stream<A, ReadError, HttpClient.HttpClient> => readStream(opts)

export const collect = <A, I>(
  opts: CollectOpts<A, I>,
): Effect.Effect<ReadonlyArray<A>, ReadError, HttpClient.HttpClient> =>
  read({ endpoint: opts.endpoint, schema: opts.schema, live: false, offset: BEGIN }).pipe(
    Stream.runCollect,
    Effect.map(Chunk.toReadonlyArray),
  )

export const head = (
  endpoint: Endpoint,
): Effect.Effect<HeadResult, TransportError | NotFound | Gone, HttpClient.HttpClient> =>
  Http.head(endpoint)

/**
 * Snapshot then follow.
 *
 * Captures the tail offset via HEAD, collects all data up to that offset, then
 * returns a live stream from the captured offset. The split is a no-gap boundary:
 * any events appended between HEAD and the start of the live read are caught up
 * to during the collect phase (since the catch-up loop runs until upToDate).
 */
export const snapshotThenFollow = <A, I>(
  opts: CollectOpts<A, I>,
): Effect.Effect<SnapshotResult<A>, ReadError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const meta = yield* head(opts.endpoint)
    const snapshot = yield* collect(opts)
    const live = read({
      endpoint: opts.endpoint,
      schema: opts.schema,
      live: true,
      offset: meta.offset,
    })
    return { snapshot, live }
  })
