import { type HttpClient } from "@effect/platform"
import { Chunk, Effect, Stream } from "effect"
import type {
  CollectOpts,
  Endpoint,
  HeadResult,
  ReadOpts,
  SnapshotResult,
} from "./DurableStream.ts"
import type { Gone, NotFound, ReadError, TransportError } from "./errors.ts"
import { arrayDecoder } from "./internal/schema.ts"
import * as Http from "./protocol/Http.ts"
import { BEGIN, catchUpAll, readStream } from "./protocol/Read.ts"

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
 * Snapshot then follow — no-gap, no-duplicate.
 *
 * Walks the catch-up read loop to completion, capturing the precise terminal
 * offset the server returned at the last in-progress response. Items past
 * that offset are guaranteed not to be in the snapshot. The returned `live`
 * stream resumes from exactly that offset, so any concurrent appends that
 * arrive during the catch-up window are observed either fully in `snapshot`
 * or fully in `live`, never in both.
 */
export const snapshotThenFollow = <A, I>(
  opts: CollectOpts<A, I>,
): Effect.Effect<SnapshotResult<A>, ReadError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const { items, finalOffset } = yield* catchUpAll(opts.endpoint, BEGIN)
    const decoded = yield* arrayDecoder(opts.schema)(items)
    const live = read({
      endpoint: opts.endpoint,
      schema: opts.schema,
      live: true,
      offset: finalOffset,
    })
    return { snapshot: decoded, live }
  })
