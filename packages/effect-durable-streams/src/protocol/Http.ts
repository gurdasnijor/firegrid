import {
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "@effect/platform"
import type { HttpClientError } from "@effect/platform/HttpClientError"
import { Effect, Schedule, Stream } from "effect"
import type { Endpoint, HeaderValue, HeadResult, Offset } from "../DurableStream.ts"
import { Gone, NotFound, StreamClosed, TransportError } from "../errors.ts"
import * as C from "./constants.ts"

// === Header resolution ===========================================

const resolveHeader = (value: HeaderValue): Effect.Effect<string, never, never> => {
  if (typeof value === "string") return Effect.succeed(value)
  const r = value()
  if (typeof r === "string") return Effect.succeed(r)
  if (Effect.isEffect(r)) return r
  return Effect.promise(() => r)
}

const resolveHeaders = (endpoint: Endpoint): Effect.Effect<Record<string, string>, never, never> =>
  Effect.gen(function* () {
    if (!endpoint.headers) return {}
    const out: Record<string, string> = {}
    for (const [name, value] of Object.entries(endpoint.headers)) {
      out[name] = yield* resolveHeader(value)
    }
    return out
  })

// === Response → typed error mapping =============================

const STREAM_NEXT_OFFSET = C.STREAM_NEXT_OFFSET
const STREAM_CLOSED = C.STREAM_CLOSED

const headerValue = (
  res: HttpClientResponse.HttpClientResponse,
  name: string,
): string | undefined => res.headers[name] ?? res.headers[name.toLowerCase()]

const isClosed = (res: HttpClientResponse.HttpClientResponse): boolean =>
  headerValue(res, STREAM_CLOSED) === "true"

/**
 * Map a non-2xx response to a typed error. Returns `Effect.fail` for protocol
 * errors (404/409/410) and `Effect.die` for unexpected status codes — any
 * unknown 5xx already passed through `retry` and exhausted, so a die is the
 * right escalation.
 */
export const failForStatus = (
  res: HttpClientResponse.HttpClientResponse,
  url: string,
): Effect.Effect<never, TransportError | NotFound | Gone | StreamClosed> => {
  const status = res.status
  if (status === 404) return Effect.fail(new NotFound({ url }))
  if (status === 410) return Effect.fail(new Gone({ url }))
  if (status === 409 && isClosed(res)) {
    const finalOffset = (headerValue(res, STREAM_NEXT_OFFSET) ?? "") as Offset
    return Effect.fail(new StreamClosed({ finalOffset }))
  }
  return Effect.fail(
    new TransportError({
      cause: new Error(`HTTP ${status} at ${url}: ${res.request.method} ${res.request.url}`),
    }),
  )
}

// === Retry policy ================================================
//
// Network-level errors (HttpClientError "RequestError") and 5xx-ish transport
// failures retry. Protocol errors (404/409/410) never retry.

const isTransient = (e: HttpClientError): boolean => e._tag === "RequestError"

const retrySchedule = Schedule.exponential("100 millis").pipe(
  // eslint-disable-next-line local/no-fixed-polling -- recurs is a retry count, not durable-runtime polling.
  Schedule.compose(Schedule.recurs(4)),
  // eslint-disable-next-line local/no-fixed-polling -- spaced is a retry-backoff floor, not durable-runtime polling.
  Schedule.either(Schedule.spaced("3 seconds")),
)

// === Request construction =======================================

export interface RequestOptions {
  readonly endpoint: Endpoint
  readonly headers?: Record<string, string>
  readonly params?: Record<string, string>
}

const buildHeaders = (
  endpoint: Endpoint,
  extra: Record<string, string> | undefined,
): Effect.Effect<Record<string, string>> =>
  Effect.map(resolveHeaders(endpoint), (base) => ({ ...base, ...(extra ?? {}) }))

const applyParams = (
  req: HttpClientRequest.HttpClientRequest,
  params: Record<string, string> | undefined,
): HttpClientRequest.HttpClientRequest => {
  if (!params) return req
  let out = req
  for (const [k, v] of Object.entries(params)) {
    out = HttpClientRequest.setUrlParam(k, v)(out)
  }
  return out
}

// === Operations ==================================================

const urlOf = (endpoint: Endpoint): string =>
  typeof endpoint.url === "string" ? endpoint.url : endpoint.url.toString()

export const head = (
  endpoint: Endpoint,
): Effect.Effect<HeadResult, TransportError | NotFound | Gone, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const url = urlOf(endpoint)
    const headers = yield* buildHeaders(endpoint, undefined)
    const client = yield* HttpClient.HttpClient
    const req = HttpClientRequest.head(url).pipe(HttpClientRequest.setHeaders(headers))
    const res = yield* client.execute(req).pipe(
      Effect.retry({ schedule: retrySchedule, while: isTransient }),
      Effect.mapError((e) => new TransportError({ cause: e })),
    )
    if (res.status === 404) return yield* Effect.fail(new NotFound({ url }))
    if (res.status === 410) return yield* Effect.fail(new Gone({ url }))
    if (res.status < 200 || res.status >= 300) {
      return yield* Effect.fail(
        new TransportError({ cause: new Error(`HEAD ${url}: status ${res.status}`) }),
      )
    }
    const offset = (headerValue(res, STREAM_NEXT_OFFSET) ?? "") as Offset
    const result: HeadResult = {
      offset,
      contentType: headerValue(res, "content-type"),
      streamClosed: isClosed(res),
      ttlSeconds: parseInt(headerValue(res, C.STREAM_TTL) ?? "", 10) || undefined,
      expiresAt: headerValue(res, C.STREAM_EXPIRES_AT),
    }
    return result
  })

export interface GetJsonResult {
  readonly items: ReadonlyArray<unknown>
  readonly nextOffset: Offset
  readonly cursor: string | undefined
  readonly upToDate: boolean
  readonly streamClosed: boolean
  readonly status: number
}

export const getJson = (
  endpoint: Endpoint,
  opts: { readonly offset: Offset; readonly live?: false | "long-poll"; readonly cursor?: string },
): Effect.Effect<GetJsonResult, TransportError | NotFound | Gone, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const url = urlOf(endpoint)
    const headers = yield* buildHeaders(endpoint, undefined)
    const params: Record<string, string> = { [C.QUERY_OFFSET]: opts.offset }
    if (opts.live === "long-poll") params[C.QUERY_LIVE] = C.LIVE_LONG_POLL
    if (opts.cursor !== undefined) params[C.QUERY_CURSOR] = opts.cursor

    const client = yield* HttpClient.HttpClient
    const req = applyParams(
      HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers)),
      params,
    )
    const res = yield* client.execute(req).pipe(
      Effect.retry({ schedule: retrySchedule, while: isTransient }),
      Effect.mapError((e) => new TransportError({ cause: e })),
    )
    if (res.status === 404) return yield* Effect.fail(new NotFound({ url }))
    if (res.status === 410) return yield* Effect.fail(new Gone({ url }))
    if (res.status !== 200 && res.status !== 204) {
      return yield* Effect.fail(
        new TransportError({ cause: new Error(`GET ${url}: status ${res.status}`) }),
      )
    }

    const nextOffset = (headerValue(res, STREAM_NEXT_OFFSET) ?? opts.offset) as Offset
    const cursor = headerValue(res, C.STREAM_CURSOR)
    const upToDate = headerValue(res, C.STREAM_UP_TO_DATE) !== undefined
    const streamClosed = isClosed(res)

    if (res.status === 204) {
      return { items: [], nextOffset, cursor, upToDate, streamClosed, status: 204 }
    }
    // 200 — parse JSON array (per protocol §7.1 reads return arrays).
    const body = yield* res.text.pipe(
      Effect.mapError((e) => new TransportError({ cause: e })),
    )
    const items: ReadonlyArray<unknown> = body.trim() === ""
      ? []
      : (() => {
          try {
            const parsed: unknown = JSON.parse(body)
            return Array.isArray(parsed) ? (parsed as ReadonlyArray<unknown>) : [parsed]
          } catch (cause) {
            throw new TransportError({ cause })
          }
        })()
    return { items, nextOffset, cursor, upToDate, streamClosed, status: 200 }
  })

/**
 * Open a raw byte-stream GET (used for SSE). Returns the response wrapped so
 * the caller can stream the body.
 */
export const getStream = (
  endpoint: Endpoint,
  opts: { readonly offset: Offset; readonly accept?: string },
): Effect.Effect<
  HttpClientResponse.HttpClientResponse,
  TransportError | NotFound | Gone,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const url = urlOf(endpoint)
    const baseHeaders = yield* buildHeaders(endpoint, undefined)
    const headers = opts.accept ? { ...baseHeaders, accept: opts.accept } : baseHeaders
    const client = yield* HttpClient.HttpClient
    const req = applyParams(
      HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers)),
      { [C.QUERY_OFFSET]: opts.offset, [C.QUERY_LIVE]: C.LIVE_SSE },
    )
    const res = yield* client.execute(req).pipe(
      Effect.retry({ schedule: retrySchedule, while: isTransient }),
      Effect.mapError((e) => new TransportError({ cause: e })),
    )
    if (res.status === 404) return yield* Effect.fail(new NotFound({ url }))
    if (res.status === 410) return yield* Effect.fail(new Gone({ url }))
    if (res.status !== 200) {
      return yield* Effect.fail(
        new TransportError({ cause: new Error(`GET stream ${url}: status ${res.status}`) }),
      )
    }
    return res
  })

export interface PostResult {
  readonly nextOffset: Offset
  readonly streamClosed: boolean
}

export interface PostOptions {
  readonly body: string
  readonly contentType?: string
  readonly seq?: string
  readonly producerId?: string
  readonly producerEpoch?: number
  readonly producerSeq?: number
  readonly streamClosed?: boolean
}

export interface PostResponse {
  readonly status: number
  readonly nextOffset: Offset
  readonly streamClosed: boolean
  readonly producerExpectedSeq: number | undefined
  readonly producerReceivedSeq: number | undefined
  readonly producerEpoch: number | undefined
}

export const post = (
  endpoint: Endpoint,
  opts: PostOptions,
): Effect.Effect<PostResponse, TransportError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const url = urlOf(endpoint)
    const extra: Record<string, string> = {}
    if (opts.seq !== undefined) extra[C.STREAM_SEQ] = opts.seq
    if (opts.producerId !== undefined) extra[C.PRODUCER_ID] = opts.producerId
    if (opts.producerEpoch !== undefined) extra[C.PRODUCER_EPOCH] = String(opts.producerEpoch)
    if (opts.producerSeq !== undefined) extra[C.PRODUCER_SEQ] = String(opts.producerSeq)
    if (opts.streamClosed) extra[C.STREAM_CLOSED] = "true"
    const headers = yield* buildHeaders(endpoint, extra)
    const client = yield* HttpClient.HttpClient
    const req = HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.bodyText(opts.body, opts.contentType ?? C.CONTENT_TYPE_JSON),
    )
    // Retry transport errors only. Protocol errors (4xx) are returned to the caller.
    const res = yield* client.execute(req).pipe(
      Effect.retry({ schedule: retrySchedule, while: isTransient }),
      Effect.mapError((e) => new TransportError({ cause: e })),
    )
    const nextOffset = (headerValue(res, STREAM_NEXT_OFFSET) ?? "") as Offset
    const streamClosed = isClosed(res)
    const expected = parseInt(headerValue(res, C.PRODUCER_EXPECTED_SEQ) ?? "", 10)
    const received = parseInt(headerValue(res, C.PRODUCER_RECEIVED_SEQ) ?? "", 10)
    const epoch = parseInt(headerValue(res, C.PRODUCER_EPOCH) ?? "", 10)
    return {
      status: res.status,
      nextOffset,
      streamClosed,
      producerExpectedSeq: Number.isFinite(expected) ? expected : undefined,
      producerReceivedSeq: Number.isFinite(received) ? received : undefined,
      producerEpoch: Number.isFinite(epoch) ? epoch : undefined,
    }
  })

export interface PutOptions {
  readonly contentType?: string
  readonly ttlSeconds?: number
  readonly expiresAt?: string
  readonly closed?: boolean
  readonly body?: string
}

export const put = (
  endpoint: Endpoint,
  opts: PutOptions,
): Effect.Effect<{ readonly status: number }, TransportError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const url = urlOf(endpoint)
    const extra: Record<string, string> = {}
    if (opts.ttlSeconds !== undefined) extra[C.STREAM_TTL] = String(opts.ttlSeconds)
    if (opts.expiresAt !== undefined) extra[C.STREAM_EXPIRES_AT] = opts.expiresAt
    if (opts.closed) extra[C.STREAM_CLOSED] = "true"
    const headers = yield* buildHeaders(endpoint, extra)
    const client = yield* HttpClient.HttpClient
    const ct = opts.contentType ?? C.CONTENT_TYPE_JSON
    const reqBase = HttpClientRequest.put(url).pipe(HttpClientRequest.setHeaders(headers))
    const req = opts.body !== undefined
      ? HttpClientRequest.bodyText(opts.body, ct)(reqBase)
      : HttpClientRequest.setHeader("content-type", ct)(reqBase)
    const res = yield* client.execute(req).pipe(
      Effect.retry({ schedule: retrySchedule, while: isTransient }),
      Effect.mapError((e) => new TransportError({ cause: e })),
    )
    return { status: res.status }
  })

export const del = (
  endpoint: Endpoint,
): Effect.Effect<{ readonly status: number }, TransportError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const url = urlOf(endpoint)
    const headers = yield* buildHeaders(endpoint, undefined)
    const client = yield* HttpClient.HttpClient
    const req = HttpClientRequest.del(url).pipe(HttpClientRequest.setHeaders(headers))
    const res = yield* client.execute(req).pipe(
      Effect.retry({ schedule: retrySchedule, while: isTransient }),
      Effect.mapError((e) => new TransportError({ cause: e })),
    )
    return { status: res.status }
  })

// Re-export Stream type for consumers that want the SSE byte stream.
export { Stream }
