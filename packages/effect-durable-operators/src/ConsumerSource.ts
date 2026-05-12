/**
 * ConsumerSource — minimal source protocol for DurableConsumer.
 *
 * Implements:
 *  - effect-durable-operators.SOURCE.1
 *  - effect-durable-operators.SOURCE.2
 *  - effect-durable-operators.SOURCE.6 (`findFirst` helper hides
 *    `Stream.runHead`/`Stream.filterMap` composition for snapshot
 *    predicate lookups)
 *  - effect-durable-operators.SOURCE.7 (`fromDurableStream` accepts an
 *    adapter-level starting cursor so DurableStream offset semantics
 *    stay inside the adapter)
 */

import type { HttpClient } from "@effect/platform"
import { Stream } from "effect"
import type { Effect, Option } from "effect"
import { DurableStream } from "effect-durable-streams"

export interface ConsumerSource<Fact, E = never, R = never> {
  readonly read: (
    options?: { readonly live?: boolean },
  ) => Stream.Stream<Fact, E, R>
}

export const fromStream = <Fact, E = never, R = never>(
  stream: Stream.Stream<Fact, E, R>,
): ConsumerSource<Fact, E, R> => ({
  read: () => stream,
})

/**
 * Options for the Durable Streams adapter. The optional `cursor` is the
 * Durable Streams stream offset to start the read at; offset semantics
 * are scoped to this adapter and are not exposed through the generic
 * `ConsumerSource` interface.
 */
export interface FromDurableStreamOptions {
  readonly cursor?: string
}

export const fromDurableStream = <Fact, FactI>(
  bound: DurableStream.Bound<Fact, FactI>,
  options?: FromDurableStreamOptions,
): ConsumerSource<Fact, DurableStream.ReadError, HttpClient.HttpClient> => {
  const offset =
    options?.cursor === undefined ? undefined : DurableStream.Offset(options.cursor)
  return {
    read: (readOpts) =>
      bound.read({
        ...(readOpts ?? {}),
        ...(offset === undefined ? {} : { offset }),
      }),
  }
}

/**
 * Snapshot predicate lookup. Reads the source as a snapshot (default
 * `live: false`) and returns the first value the predicate maps to
 * `Some(...)`, or `Option.none()` if the snapshot closes without one.
 *
 * Useful any time a caller wants "first source item matching X" without
 * hand-rolling `Stream.runHead(source.read({...}).pipe(Stream.filterMap(...)))`.
 */
export const findFirst = <A, B, E, R>(
  source: ConsumerSource<A, E, R>,
  predicate: (a: A) => Option.Option<B>,
  options?: { readonly live?: boolean },
): Effect.Effect<Option.Option<B>, E, R> =>
  Stream.runHead(
    source
      .read({ live: options?.live ?? false })
      .pipe(Stream.filterMap(predicate)),
  )
