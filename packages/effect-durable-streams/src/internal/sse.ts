import { type HttpClient } from "@effect/platform"
import { Chunk, Effect, Ref, Schedule, Stream } from "effect"
import { createParser, type EventSourceMessage } from "eventsource-parser"
import type { Endpoint, Offset } from "../DurableStream.ts"
import { Offset as MkOffset } from "../DurableStream.ts"
import type { ReadError } from "../errors.ts"
import { TransportError } from "../errors.ts"
import * as C from "../protocol/constants.ts"
import * as Http from "../protocol/Http.ts"

interface ParsedControl {
  readonly streamNextOffset?: string
  readonly streamCursor?: string
  readonly streamClosed?: boolean
  readonly upToDate?: boolean
}

const parseControl = (data: string): ParsedControl => {
  try {
    return JSON.parse(data) as ParsedControl
  } catch {
    return {}
  }
}

const parseDataPayload = (data: string): ReadonlyArray<unknown> => {
  const trimmed = data.trim()
  if (trimmed === "") return []
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return Array.isArray(parsed) ? (parsed as ReadonlyArray<unknown>) : [parsed]
  } catch {
    return []
  }
}

/**
 * Open one SSE connection, emit items as they arrive, and update the shared
 * `offsetRef` / `closedRef`. Inner stream ends when the response body ends.
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

      const bytes: Stream.Stream<Uint8Array, ReadError> = res.stream.pipe(
        Stream.mapError((e): ReadError => new TransportError({ cause: e })),
      )

      // Bridge the byte stream → eventsource-parser → Stream<EventSourceMessage>.
      const events: Stream.Stream<EventSourceMessage, ReadError> = Stream.async<
        EventSourceMessage,
        ReadError
      >((emit) => {
        const parser = createParser({
          onEvent: (event) => {
            void emit.single(event)
          },
          onError: (err) => {
            void emit.fail(new TransportError({ cause: err }))
          },
        })
        const decoder = new TextDecoder()
        void Effect.runPromise(
          bytes.pipe(
            Stream.runForEach((chunk) =>
              Effect.sync(() => parser.feed(decoder.decode(chunk, { stream: true }))),
            ),
            Effect.matchEffect({
              onFailure: (e) => Effect.sync(() => void emit.fail(e)),
              onSuccess: () => Effect.sync(() => void emit.end()),
            }),
          ),
        )
      })

      return events.pipe(
        Stream.mapConcatChunkEffect((event) =>
          Effect.gen(function* () {
            const name = event.event ?? "message"
            if (name === C.SSE_EVENT_DATA || name === "message") {
              return Chunk.unsafeFromArray(parseDataPayload(event.data).slice())
            }
            if (name === C.SSE_EVENT_CONTROL) {
              const ctrl = parseControl(event.data)
              if (typeof ctrl.streamNextOffset === "string") {
                yield* Ref.set(offsetRef, MkOffset(ctrl.streamNextOffset))
              }
              if (ctrl.streamClosed === true) {
                yield* Ref.set(closedRef, true)
              }
              return Chunk.empty<unknown>()
            }
            return Chunk.empty<unknown>()
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
