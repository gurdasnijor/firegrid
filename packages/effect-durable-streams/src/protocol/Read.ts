import { type HttpClient } from "@effect/platform"
import { Chunk, Effect, Option, Stream } from "effect"
import type {
  Endpoint,
  HeadersRecord,
  LiveMode,
  Offset,
  ReadOpts,
} from "../DurableStream.ts"
import { Offset as MkOffset } from "../DurableStream.ts"
import type { ReadError } from "../errors.ts"
import { arrayDecoder } from "../internal/schema.ts"
import { sseStream } from "../internal/sse.ts"
import * as Http from "./Http.ts"
import * as C from "./constants.ts"

const BEGIN = MkOffset(C.OFFSET_BEGIN)

// ============================================================================
// Catch-up (live: false) — terminates on first up-to-date or stream-closed
// ============================================================================

interface CatchUpState {
  readonly offset: Offset
  readonly done: boolean
  /**
   * Sent as `If-None-Match` on the next request. Cleared after the first
   * use — the body of subsequent batches isn't conditionally fetched.
   */
  readonly nextIfNoneMatch: string | undefined
}

const catchUpLoop = (
  endpoint: Endpoint,
  startOffset: Offset,
  ifNoneMatch?: string,
  callHeaders?: HeadersRecord,
): Stream.Stream<unknown, ReadError, HttpClient.HttpClient> =>
  Stream.paginateChunkEffect<CatchUpState, unknown, ReadError, HttpClient.HttpClient>(
    { offset: startOffset, done: false, nextIfNoneMatch: ifNoneMatch },
    (state) => {
      if (state.done) return Effect.succeed([Chunk.empty(), Option.none()])
      return Effect.gen(function* () {
        const reqOpts: Parameters<typeof Http.getJson>[1] = {
          offset: state.offset,
          live: false,
          ...(state.nextIfNoneMatch !== undefined
            ? { ifNoneMatch: state.nextIfNoneMatch }
            : {}),
          ...(callHeaders !== undefined ? { callHeaders } : {}),
        }
        const res = yield* Http.getJson(endpoint, reqOpts)
        // 304: server says nothing new. Terminate immediately.
        if (res.notModified) {
          return [Chunk.empty<unknown>(), Option.none<CatchUpState>()] as const
        }
        const items = Chunk.unsafeFromArray(res.items.slice())
        const next: Option.Option<CatchUpState> = res.upToDate || res.streamClosed
          ? Option.none()
          : Option.some({
              offset: res.nextOffset,
              done: false,
              nextIfNoneMatch: undefined,
            })
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
  callHeaders?: HeadersRecord,
): Stream.Stream<unknown, ReadError, HttpClient.HttpClient> =>
  Stream.unfoldChunkEffect<LongPollState, unknown, ReadError, HttpClient.HttpClient>(
    { offset: startOffset, cursor: undefined },
    (state) =>
      Effect.gen(function* () {
        const baseOpts = state.cursor !== undefined
          ? ({
              offset: state.offset,
              live: "long-poll" as const,
              cursor: state.cursor,
            })
          : ({ offset: state.offset, live: "long-poll" as const })
        const getOpts = callHeaders !== undefined
          ? { ...baseOpts, callHeaders }
          : baseOpts
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
  callHeaders?: HeadersRecord,
): Stream.Stream<unknown, ReadError, HttpClient.HttpClient> =>
  sseStream(endpoint, startOffset, callHeaders)

// ============================================================================
// Public read entry point
// ============================================================================

const resolveStart = (_live: LiveMode | undefined, offset: Offset | undefined): Offset => {
  // Default is always BEGIN — caller gets "catch up from start, then tail live".
  // To tail from current end only, pass `offset: "now" as Offset`.
  return offset ?? BEGIN
}

export const readStream = <A, I>(
  opts: ReadOpts<A, I>,
): Stream.Stream<A, ReadError, HttpClient.HttpClient> => {
  const live = opts.live ?? true
  const startOffset = resolveStart(live, opts.offset)
  const callHeaders = opts.headers
  // `live: true` is auto-select. SSE is the preferred live mode for JSON
  // streams (matches reference behavior). Callers behind proxies / CDNs
  // that don't honor SSE flush can pass explicit `live: "long-poll"`.
  // Binary streams should also pick long-poll explicitly.
  const raw: Stream.Stream<unknown, ReadError, HttpClient.HttpClient> = live === false
    ? catchUpLoop(opts.endpoint, startOffset, opts.ifNoneMatch, callHeaders)
    : live === "long-poll"
      ? longPollLoop(opts.endpoint, startOffset, callHeaders)
      : sseLoop(opts.endpoint, startOffset, callHeaders)
  const decode = arrayDecoder(opts.schema)
  return raw.pipe(
    Stream.mapChunksEffect((chunk) =>
      decode(Chunk.toReadonlyArray(chunk)).pipe(
        Effect.map((arr) => Chunk.unsafeFromArray(arr.slice())),
      ),
    ),
  )
}

// ============================================================================
// Collect-all with terminal offset (used by Reader.snapshotThenFollow for a
// no-gap, no-duplicate handoff from snapshot to live).
//
// Unlike `catchUpLoop`, this returns both the items and the EXACT offset the
// server returned at the last in-progress response — guaranteed > every item
// in the snapshot, and the natural resume point for a live read.
// ============================================================================

export const catchUpAll = (
  endpoint: Endpoint,
  startOffset: Offset = BEGIN,
  callHeaders?: HeadersRecord,
): Effect.Effect<
  { readonly items: ReadonlyArray<unknown>; readonly finalOffset: Offset },
  ReadError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const items: Array<unknown> = []
    let offset = startOffset
    while (true) {
      const res = yield* Http.getJson(endpoint, {
        offset,
        live: false,
        ...(callHeaders !== undefined ? { callHeaders } : {}),
      })
      items.push(...res.items)
      offset = res.nextOffset
      if (res.upToDate || res.streamClosed) break
    }
    return { items, finalOffset: offset }
  })

// Helpers re-exported for Reader.
export { BEGIN }
