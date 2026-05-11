import { type HttpClient } from "@effect/platform"
import { Chunk, Effect, Option, Stream } from "effect"
import type { Endpoint, LiveMode, Offset, ReadOpts } from "../DurableStream.ts"
import { Offset as MkOffset } from "../DurableStream.ts"
import type { ReadError } from "../errors.ts"
import { arrayDecoder } from "../internal/schema.ts"
import * as Http from "./Http.ts"
import * as C from "./constants.ts"

const BEGIN = MkOffset(C.OFFSET_BEGIN)
const NOW = MkOffset(C.OFFSET_NOW)

// ============================================================================
// Catch-up (live: false) — terminates on first up-to-date or stream-closed
// ============================================================================

interface CatchUpState {
  readonly offset: Offset
  readonly done: boolean
}

const catchUpLoop = (
  endpoint: Endpoint,
  startOffset: Offset,
): Stream.Stream<unknown, ReadError, HttpClient.HttpClient> =>
  Stream.paginateChunkEffect<CatchUpState, unknown, ReadError, HttpClient.HttpClient>(
    { offset: startOffset, done: false },
    (state) => {
      if (state.done) return Effect.succeed([Chunk.empty(), Option.none()])
      return Effect.gen(function* () {
        const res = yield* Http.getJson(endpoint, { offset: state.offset, live: false })
        const items = Chunk.unsafeFromArray(res.items.slice())
        const next: Option.Option<CatchUpState> = res.upToDate || res.streamClosed
          ? Option.none()
          : Option.some({ offset: res.nextOffset, done: false })
        return [items, next] as const
      })
    },
  )

// ============================================================================
// Long-poll (live: "long-poll") — keeps polling until stream-closed
// ============================================================================

interface LongPollState {
  readonly offset: Offset
  readonly cursor: string | undefined
}

const longPollLoop = (
  endpoint: Endpoint,
  startOffset: Offset,
): Stream.Stream<unknown, ReadError, HttpClient.HttpClient> =>
  Stream.unfoldChunkEffect<LongPollState, unknown, ReadError, HttpClient.HttpClient>(
    { offset: startOffset, cursor: undefined },
    (state) =>
      Effect.gen(function* () {
        const getOpts = state.cursor !== undefined
          ? ({
              offset: state.offset,
              live: "long-poll" as const,
              cursor: state.cursor,
            })
          : ({ offset: state.offset, live: "long-poll" as const })
        const res = yield* Http.getJson(endpoint, getOpts)
        if (res.streamClosed && res.items.length === 0) {
          return Option.none()
        }
        const next: LongPollState = {
          offset: res.nextOffset,
          cursor: res.cursor ?? state.cursor,
        }
        return Option.some([Chunk.unsafeFromArray(res.items.slice()), next] as const)
      }),
  )

// ============================================================================
// SSE (live: "sse")
// ============================================================================

const sseLoop = (
  endpoint: Endpoint,
  startOffset: Offset,
): Stream.Stream<unknown, ReadError, HttpClient.HttpClient> =>
  Stream.unwrap(
    Effect.gen(function* () {
      // Defer to internal/sse.ts where the eventsource-parser bridge lives.
      const { sseStream } = yield* Effect.promise(() => import("../internal/sse.ts"))
      return sseStream(endpoint, startOffset)
    }),
  )

// ============================================================================
// Public read entry point
// ============================================================================

const resolveStart = (_live: LiveMode | undefined, offset: Offset | undefined): Offset => {
  // Default is always BEGIN — caller gets "catch up from start, then tail live".
  // To tail from current end only, pass `offset: "now" as Offset`.
  return offset ?? BEGIN
}
void NOW

export const readStream = <A, I>(
  opts: ReadOpts<A, I>,
): Stream.Stream<A, ReadError, HttpClient.HttpClient> => {
  const live = opts.live ?? true
  const startOffset = resolveStart(live, opts.offset)
  const raw: Stream.Stream<unknown, ReadError, HttpClient.HttpClient> = live === false
    ? catchUpLoop(opts.endpoint, startOffset)
    : live === "sse"
      ? sseLoop(opts.endpoint, startOffset)
      : longPollLoop(opts.endpoint, startOffset)
  const decode = arrayDecoder(opts.schema)
  return raw.pipe(
    Stream.mapChunksEffect((chunk) =>
      decode(Chunk.toReadonlyArray(chunk)).pipe(
        Effect.map((arr) => Chunk.unsafeFromArray(arr.slice())),
      ),
    ),
  )
}

// Helpers re-exported for Reader.
export { BEGIN, NOW }
