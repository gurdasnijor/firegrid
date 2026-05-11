import {
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "@effect/platform"
import type { HttpClientError } from "@effect/platform/HttpClientError"
import { Effect, Schedule } from "effect"
import type { Endpoint, HeaderValue, HeadResult, Offset } from "../DurableStream.ts"
import { Gone, NotFound, TransportError } from "../errors.ts"
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

// === Retry policy ================================================
//
// Network-level errors (HttpClientError "RequestError") and 5xx-ish transport
// failures retry. Protocol errors (404/409/410) never retry.

const isTransient = (e: HttpClientError): boolean => e._tag === "RequestError"

const defaultRetrySchedule = Schedule.exponential("100 millis").pipe(
  // eslint-disable-next-line local/no-fixed-polling -- recurs is a retry count, not durable-runtime polling.
  Schedule.compose(Schedule.recurs(4)),
  // eslint-disable-next-line local/no-fixed-polling -- spaced is a retry-backoff floor, not durable-runtime polling.
  Schedule.either(Schedule.spaced("3 seconds")),
)

const scheduleFor = (endpoint: Endpoint): Schedule.Schedule<unknown, unknown, never> =>
  endpoint.retrySchedule ?? defaultRetrySchedule

// === Request construction =======================================

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

// === onError retry hook ==========================================
//
// Wrap any HTTP operation with the endpoint's `onError` handler (if set).
// The handler is invoked after transport-level retries exhaust and the
// operation fails. If it returns `RetryOpts`, headers are merged into the
// endpoint and the operation is retried — bounded by `onErrorMaxRetries`
// to prevent runaway loops. If it returns `undefined`, the original error
// propagates.

const withOnErrorHandler = <A, E, R>(
  endpoint: Endpoint,
  attempt: (ep: Endpoint) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const handler = endpoint.onError
  if (!handler) return attempt(endpoint)
  const cap = endpoint.onErrorMaxRetries ?? 4
  const loop = (ep: Endpoint, attemptsLeft: number): Effect.Effect<A, E, R> =>
    attempt(ep).pipe(
      Effect.catchAll((err) => {
        if (attemptsLeft <= 0) return Effect.fail(err)
        return Effect.flatMap(handler(err), (retry) => {
          if (!retry) return Effect.fail(err)
          const merged: Endpoint = {
            ...ep,
            headers: { ...(ep.headers ?? {}), ...(retry.headers ?? {}) },
          }
          return loop(merged, attemptsLeft - 1)
        })
      }),
    )
  return loop(endpoint, cap)
}

// === Operations ==================================================

const urlOf = (endpoint: Endpoint): string =>
  typeof endpoint.url === "string" ? endpoint.url : endpoint.url.toString()

/**
 * Shared request-execution boilerplate: build headers, build the request via
 * the caller's shaper, execute with the endpoint's retry schedule, map
 * transport errors. Returns the raw response — caller inspects status.
 */
const executeWithRetry = (
  endpoint: Endpoint,
  shape: (
    url: string,
    headers: Record<string, string>,
  ) => HttpClientRequest.HttpClientRequest,
  extraHeaders?: Record<string, string>,
): Effect.Effect<HttpClientResponse.HttpClientResponse, TransportError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const url = urlOf(endpoint)
    const headers = yield* buildHeaders(endpoint, extraHeaders)
    const client = yield* HttpClient.HttpClient
    return yield* client.execute(shape(url, headers)).pipe(
      Effect.retry({ schedule: scheduleFor(endpoint), while: isTransient }),
      Effect.mapError((e) => new TransportError({ cause: e })),
    )
  })

const headInner = (
  endpoint: Endpoint,
): Effect.Effect<HeadResult, TransportError | NotFound | Gone, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const url = urlOf(endpoint)
    const res = yield* executeWithRetry(endpoint, (u, h) =>
      HttpClientRequest.head(u).pipe(HttpClientRequest.setHeaders(h)),
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
      etag: headerValue(res, "etag"),
      cacheControl: headerValue(res, "cache-control"),
    }
    return result
  })

export const head = (
  endpoint: Endpoint,
): Effect.Effect<HeadResult, TransportError | NotFound | Gone, HttpClient.HttpClient> =>
  withOnErrorHandler(endpoint, headInner)

interface GetJsonResult {
  readonly items: ReadonlyArray<unknown>
  readonly nextOffset: Offset
  readonly cursor: string | undefined
  readonly upToDate: boolean
  readonly streamClosed: boolean
  readonly status: number
  readonly etag: string | undefined
  readonly notModified: boolean
}

export const getJson = (
  endpoint: Endpoint,
  opts: {
    readonly offset: Offset
    readonly live?: false | "long-poll"
    readonly cursor?: string
    /**
     * If supplied, send `If-None-Match: <etag>`. Server may return 304 Not
     * Modified — caller treats that as "no new data since last read" and
     * keeps using the prior offset + body. See §8.1.
     */
    readonly ifNoneMatch?: string
  },
): Effect.Effect<GetJsonResult, TransportError | NotFound | Gone, HttpClient.HttpClient> =>
  withOnErrorHandler(endpoint, (ep) => getJsonInner(ep, opts))

const getJsonInner = (
  endpoint: Endpoint,
  opts: {
    readonly offset: Offset
    readonly live?: false | "long-poll"
    readonly cursor?: string
    readonly ifNoneMatch?: string
  },
): Effect.Effect<GetJsonResult, TransportError | NotFound | Gone, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const url = urlOf(endpoint)
    const extra: Record<string, string> = {}
    if (opts.ifNoneMatch !== undefined) extra["if-none-match"] = opts.ifNoneMatch
    const params: Record<string, string> = { [C.QUERY_OFFSET]: opts.offset }
    if (opts.live === "long-poll") params[C.QUERY_LIVE] = C.LIVE_LONG_POLL
    if (opts.cursor !== undefined) params[C.QUERY_CURSOR] = opts.cursor

    const res = yield* executeWithRetry(
      endpoint,
      (u, h) =>
        applyParams(HttpClientRequest.get(u).pipe(HttpClientRequest.setHeaders(h)), params),
      extra,
    )
    if (res.status === 404) return yield* Effect.fail(new NotFound({ url }))
    if (res.status === 410) return yield* Effect.fail(new Gone({ url }))
    if (res.status === 304) {
      // Server says "nothing changed since the etag you sent". Surface as
      // an empty result with notModified=true — caller decides whether to
      // poll again later or treat as up-to-date.
      return {
        items: [],
        nextOffset: opts.offset,
        cursor: headerValue(res, C.STREAM_CURSOR),
        upToDate: true,
        streamClosed: isClosed(res),
        status: 304,
        etag: opts.ifNoneMatch,
        notModified: true,
      }
    }
    if (res.status !== 200 && res.status !== 204) {
      return yield* Effect.fail(
        new TransportError({ cause: new Error(`GET ${url}: status ${res.status}`) }),
      )
    }

    const nextOffset = (headerValue(res, STREAM_NEXT_OFFSET) ?? opts.offset) as Offset
    const cursor = headerValue(res, C.STREAM_CURSOR)
    const upToDate = headerValue(res, C.STREAM_UP_TO_DATE) !== undefined
    const streamClosed = isClosed(res)
    const etag = headerValue(res, "etag")

    if (res.status === 204) {
      return {
        items: [],
        nextOffset,
        cursor,
        upToDate,
        streamClosed,
        status: 204,
        etag,
        notModified: false,
      }
    }
    // 200 — parse JSON array (per protocol §7.1 reads return arrays).
    const body = yield* res.text.pipe(
      Effect.mapError((e) => new TransportError({ cause: e })),
    )
    // Parse the JSON body via Effect.try so a malformed response surfaces
    // as a typed TransportError on the error channel — never a defect.
    const items: ReadonlyArray<unknown> = body.trim() === ""
      ? []
      : yield* Effect.try({
          try: (): ReadonlyArray<unknown> => {
            const parsed: unknown = JSON.parse(body)
            return Array.isArray(parsed) ? (parsed as ReadonlyArray<unknown>) : [parsed]
          },
          catch: (cause) => new TransportError({ cause }),
        })
    return {
      items,
      nextOffset,
      cursor,
      upToDate,
      streamClosed,
      status: 200,
      etag,
      notModified: false,
    }
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
  withOnErrorHandler(endpoint, (ep) =>
    Effect.gen(function* () {
      const url = urlOf(ep)
      const extra = opts.accept ? { accept: opts.accept } : undefined
      const res = yield* executeWithRetry(
        ep,
        (u, h) =>
          applyParams(HttpClientRequest.get(u).pipe(HttpClientRequest.setHeaders(h)), {
            [C.QUERY_OFFSET]: opts.offset,
            [C.QUERY_LIVE]: C.LIVE_SSE,
          }),
        extra,
      )
      if (res.status === 404) return yield* Effect.fail(new NotFound({ url }))
      if (res.status === 410) return yield* Effect.fail(new Gone({ url }))
      if (res.status !== 200) {
        return yield* Effect.fail(
          new TransportError({
            cause: new Error(`GET stream ${url}: status ${res.status}`),
          }),
        )
      }
      return res
    }),
  )

export interface PostOptions {
  readonly body: string
  readonly contentType?: string
  readonly seq?: string
  readonly producerId?: string
  readonly producerEpoch?: number
  readonly producerSeq?: number
  readonly streamClosed?: boolean
}

interface PostResponse {
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
  withOnErrorHandler(endpoint, (ep) => postInner(ep, opts))

const postInner = (
  endpoint: Endpoint,
  opts: PostOptions,
): Effect.Effect<PostResponse, TransportError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    void urlOf // kept for clarity in stack traces
    const extra: Record<string, string> = {}
    if (opts.seq !== undefined) extra[C.STREAM_SEQ] = opts.seq
    if (opts.producerId !== undefined) extra[C.PRODUCER_ID] = opts.producerId
    if (opts.producerEpoch !== undefined) extra[C.PRODUCER_EPOCH] = String(opts.producerEpoch)
    if (opts.producerSeq !== undefined) extra[C.PRODUCER_SEQ] = String(opts.producerSeq)
    if (opts.streamClosed) extra[C.STREAM_CLOSED] = "true"
    // Retry transport errors only. Protocol errors (4xx) are returned to the caller.
    const res = yield* executeWithRetry(
      endpoint,
      (u, h) =>
        HttpClientRequest.post(u).pipe(
          HttpClientRequest.setHeaders(h),
          HttpClientRequest.bodyText(opts.body, opts.contentType ?? C.CONTENT_TYPE_JSON),
        ),
      extra,
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
  withOnErrorHandler(endpoint, (ep) => putInner(ep, opts))

const putInner = (
  endpoint: Endpoint,
  opts: PutOptions,
): Effect.Effect<{ readonly status: number }, TransportError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const extra: Record<string, string> = {}
    if (opts.ttlSeconds !== undefined) extra[C.STREAM_TTL] = String(opts.ttlSeconds)
    if (opts.expiresAt !== undefined) extra[C.STREAM_EXPIRES_AT] = opts.expiresAt
    if (opts.closed) extra[C.STREAM_CLOSED] = "true"
    const ct = opts.contentType ?? C.CONTENT_TYPE_JSON
    const res = yield* executeWithRetry(
      endpoint,
      (u, h) => {
        const base = HttpClientRequest.put(u).pipe(HttpClientRequest.setHeaders(h))
        return opts.body !== undefined
          ? HttpClientRequest.bodyText(opts.body, ct)(base)
          : HttpClientRequest.setHeader("content-type", ct)(base)
      },
      extra,
    )
    return { status: res.status }
  })

export const del = (
  endpoint: Endpoint,
): Effect.Effect<{ readonly status: number }, TransportError, HttpClient.HttpClient> =>
  withOnErrorHandler(endpoint, delInner)

const delInner = (
  endpoint: Endpoint,
): Effect.Effect<{ readonly status: number }, TransportError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const res = yield* executeWithRetry(endpoint, (u, h) =>
      HttpClientRequest.del(u).pipe(HttpClientRequest.setHeaders(h)),
    )
    return { status: res.status }
  })

