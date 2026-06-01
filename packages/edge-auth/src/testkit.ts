/**
 * In-memory durable-streams double — the validation substrate for the
 * edge-auth layer (and reusable by the tf-r06u.42 intent-observer tests). It
 * implements {@link DurableStreamsForwarder} over plain per-stream arrays so
 * the whole auth path (verify -> resolve -> forward) can be exercised
 * end-to-end without a live durable-streams server.
 *
 * Offsets are the count of events seen so far (a gap-free monotone integer
 * rendered as a string), mirroring the durable-streams contract that the edge
 * round-trips an opaque `Stream-Next-Offset` cursor. This is a test double,
 * not a durable-streams reimplementation.
 */
import { Effect, Layer, Option } from "effect"
import { DurableStreamsForwarder, ForwardGone } from "./forwarder.ts"

export interface InMemoryForwarder {
  /** Layer providing {@link DurableStreamsForwarder} backed by memory. */
  readonly layer: Layer.Layer<DurableStreamsForwarder>
  /** Inspect what was appended, by resolved stream name. */
  readonly dump: () => ReadonlyMap<string, ReadonlyArray<unknown>>
  /** Directly seed an output stream (simulate agent emission for read tests). */
  readonly seed: (streamName: string, events: ReadonlyArray<unknown>) => void
  /** Simulate retention trimming: a read whose offset is strictly before
   * `beforeOffset` returns `ForwardGone` (durable-streams `410`). */
  readonly trim: (streamName: string, beforeOffset: number) => void
}

export const makeInMemoryForwarder = (): InMemoryForwarder => {
  const streams = new Map<string, Array<unknown>>()
  const trimmed = new Map<string, number>()
  const at = (name: string): Array<unknown> => {
    const existing = streams.get(name)
    if (existing !== undefined) return existing
    const fresh: Array<unknown> = []
    streams.set(name, fresh)
    return fresh
  }

  const layer = Layer.succeed(
    DurableStreamsForwarder,
    DurableStreamsForwarder.of({
      head: (streamName) =>
        Effect.sync(() => {
          const arr = streams.get(streamName)
          return arr !== undefined && arr.length > 0
            ? Option.some(String(arr.length))
            : Option.none()
        }),
      append: (streamName, body) =>
        Effect.sync(() => {
          const arr = at(streamName)
          arr.push(body)
          return { offset: String(arr.length), deduplicated: false }
        }),
      read: (streamName, offset) =>
        Effect.suspend(() => {
          const arr = streams.get(streamName) ?? []
          const from = Option.match(offset, {
            onNone: () => 0,
            onSome: (o) => {
              const n = Number.parseInt(o, 10)
              return Number.isFinite(n) && n >= 0 ? n : 0
            },
          })
          const trimBefore = trimmed.get(streamName)
          if (trimBefore !== undefined && from < trimBefore) {
            return Effect.fail(new ForwardGone({ streamName }))
          }
          return Effect.succeed({
            events: arr.slice(from),
            nextOffset: String(arr.length),
            upToDate: true,
          })
        }),
    }),
  )

  return {
    layer,
    dump: () => streams,
    seed: (streamName, events) => {
      at(streamName).push(...events)
    },
    trim: (streamName, beforeOffset) => {
      trimmed.set(streamName, beforeOffset)
    },
  }
}
