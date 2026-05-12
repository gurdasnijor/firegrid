/**
 * ConsumerSource — minimal source protocol for DurableConsumer.
 *
 * Implements:
 *  - effect-durable-operators.SOURCE.1
 *  - effect-durable-operators.SOURCE.2
 */

import type { HttpClient } from "@effect/platform"
import type { Stream } from "effect"
import type { DurableStream } from "effect-durable-streams"

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

export const fromDurableStream = <Fact, FactI>(
  bound: DurableStream.Bound<Fact, FactI>,
): ConsumerSource<Fact, DurableStream.ReadError, HttpClient.HttpClient> => ({
  read: options => bound.read(options),
})
