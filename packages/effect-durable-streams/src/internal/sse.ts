import { type HttpClient } from "@effect/platform"
import { Chunk, Effect, Ref, Schedule, Stream } from "effect"
import { createParser } from "eventsource-parser"
import type { Endpoint, Offset } from "../DurableStream.ts"
import { Offset as MkOffset } from "../DurableStream.ts"
import type { ReadError } from "../errors.ts"
import { DecodeError, TransportError } from "../errors.ts"
import * as C from "../protocol/constants.ts"
import * as Http from "../protocol/Http.ts"

interface ParsedControl {
  readonly streamNextOffset?: string
  readonly streamCursor?: string
  readonly streamClosed?: boolean
  readonly upToDate?: boolean
}

const parseControl = (data: string): Effect.Effect<ParsedControl, DecodeError> =>
  Effect.try({
    try: () => JSON.parse(data) as ParsedControl,
    catch: (cause) => new DecodeError({ cause, raw: data }),
  })

const parseDataPayload = (
  data: string,
): Effect.Effect<ReadonlyArray<unknown>, DecodeError> => {
  const trimmed = data.trim()
  if (trimmed === "") return Effect.succeed([])
  return Effect.try({
    try: (): ReadonlyArray<unknown> => {
      const parsed: unknown = JSON.parse(trimmed)
      return Array.isArray(parsed) ? (parsed as ReadonlyArray<unknown>) : [parsed]
    },
    catch: (cause) => new DecodeError({ cause, raw: data }),
  })
}

/**
 * Open one SSE connection and emit items. The byte stream is the canonical
 * lifecycle source — when the consumer cancels (e.g., `Stream.take(N)` is
 * satisfied), the response body stream is cancelled by HttpClient/the scope,
 * which terminates everything below. No unmanaged Promise.
 *
 * `eventsource-parser` is a synchronous push-style parser: each `feed(text)`
 * call invokes `onEvent` 0+ times. We collect emitted events in a per-chunk
 * buffer that's drained inside `mapConcatChunkEffect`, so the parser never
 * outlives the surrounding scope.
 */
const sseConnection = (
  endpoint: Endpoint,
  offsetRef: Ref.Ref<Offset>,
  closedRef: Ref.Ref<boolean>,
): Stream.Stream<unknown, ReadError, HttpClient.HttpClient> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const offset = yield* Ref.get(offsetRef)
      const res = yield* Http.getStream(endpoint, {
        offset,
        accept: C.CONTENT_TYPE_SSE,
      })

      // Per-connection state: parser, decoder, buffer for emitted events,
      // and a slot for any parser-level error. These are captured by the
      // closure passed to `mapConcatChunkEffect` so they live exactly as
      // long as the byte stream below.
      const decoder = new TextDecoder()
      const eventBuffer: Array<{ event: string | undefined; data: string }> = []
      let parseError: Error | null = null
      const parser = createParser({
        onEvent: (event) => {
          eventBuffer.push({ event: event.event, data: event.data })
        },
        onError: (err) => {
          parseError = err
        },
      })

      return res.stream.pipe(
        Stream.mapError((e): ReadError => new TransportError({ cause: e })),
        Stream.mapConcatChunkEffect((bytes: Uint8Array) =>
          Effect.gen(function* () {
            eventBuffer.length = 0
            parser.feed(decoder.decode(bytes, { stream: true }))
            if (parseError !== null) {
              const e = parseError
              parseError = null
              return yield* Effect.fail(new TransportError({ cause: e }))
            }
            const out: Array<unknown> = []
            for (const event of eventBuffer) {
              const name = event.event ?? "message"
              if (name === C.SSE_EVENT_DATA || name === "message") {
                const items = yield* parseDataPayload(event.data)
                for (const item of items) out.push(item)
              } else if (name === C.SSE_EVENT_CONTROL) {
                const ctrl = yield* parseControl(event.data)
                if (typeof ctrl.streamNextOffset === "string") {
                  yield* Ref.set(offsetRef, MkOffset(ctrl.streamNextOffset))
                }
                if (ctrl.streamClosed === true) {
                  yield* Ref.set(closedRef, true)
                }
              }
            }
            return Chunk.unsafeFromArray(out)
          }),
        ),
      )
    }),
  )

/**
 * Stream items via SSE with automatic reconnection. The server closes
 * connections every ~60s (§8.2). On end of stream we re-open from the last
 * tracked offset. Terminates permanently once `streamClosed: true` is seen.
 */
export const sseStream = (
  endpoint: Endpoint,
  startOffset: Offset,
): Stream.Stream<unknown, ReadError, HttpClient.HttpClient> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const offsetRef = yield* Ref.make<Offset>(startOffset)
      const closedRef = yield* Ref.make<boolean>(false)

      const round = Stream.suspend((): Stream.Stream<unknown, ReadError, HttpClient.HttpClient> =>
        sseConnection(endpoint, offsetRef, closedRef),
      )

      // Repeat forever; outer `takeUntilEffect` exits when closedRef flips.
      return round.pipe(
        Stream.repeat(Schedule.forever),
        Stream.takeUntilEffect(() => Ref.get(closedRef)),
      )
    }),
  )
