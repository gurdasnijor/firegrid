import { type HttpClient } from "@effect/platform"
import { Effect, type Scope } from "effect"
import type {
  AppendOpts,
  CloseOptions,
  CreateOptions,
  Endpoint,
  HeadersRecord,
  Offset,
  Producer as ProducerType,
  ProducerMakeOpts,
} from "./DurableStream.ts"
import {
  Conflict,
  Gone,
  NotFound,
  StreamClosed,
  TransportError,
} from "./errors.ts"
import type { WriteError } from "./errors.ts"
import { encodeUnsafe } from "./internal/schema.ts"
import * as Http from "./protocol/Http.ts"
import * as ProducerImpl from "./protocol/Producer.ts"

/** One-shot append. Encodes via schema, POSTs as a single-element JSON array. */
export const append = <A, I>(
  opts: AppendOpts<A, I>,
): Effect.Effect<{ readonly offset: Offset }, WriteError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const encoded = encodeUnsafe(opts.schema)(opts.event)
    const body = JSON.stringify([encoded])
    const postOpts: Http.PostOptions = {
      body,
      ...(opts.seq !== undefined ? { seq: opts.seq } : {}),
      ...(opts.headers !== undefined ? { callHeaders: opts.headers } : {}),
    }
    const res = yield* Http.post(opts.endpoint, postOpts)
    if (res.status === 200 || res.status === 204) {
      if (res.streamClosed) {
        return yield* Effect.fail(new StreamClosed({ finalOffset: res.nextOffset }))
      }
      return { offset: res.nextOffset }
    }
    if (res.status === 409) {
      if (res.streamClosed) {
        return yield* Effect.fail(new StreamClosed({ finalOffset: res.nextOffset }))
      }
      return yield* Effect.fail(new Conflict({ reason: "409 Conflict on append" }))
    }
    if (res.status === 404) {
      return yield* Effect.fail(new NotFound({ url: String(opts.endpoint.url) }))
    }
    if (res.status === 410) {
      // Stream has been deleted. Distinguish from 404 (never existed) so
      // callers can branch on the difference (e.g., 410 → don't retry).
      return yield* Effect.fail(new Gone({ url: String(opts.endpoint.url) }))
    }
    return yield* Effect.fail(
      new TransportError({ cause: new Error(`POST returned status ${res.status}`) }),
    )
  })

export const producer = <A, I>(
  opts: ProducerMakeOpts<A, I>,
): Effect.Effect<ProducerType<A>, TransportError, HttpClient.HttpClient | Scope.Scope> =>
  ProducerImpl.make(opts)

// ============================================================================
// Stream lifecycle: create / close / delete
// ============================================================================

export const create = (
  endpoint: Endpoint,
  opts: CreateOptions = {},
): Effect.Effect<void, TransportError | Conflict, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const putOpts: Http.PutOptions = {
      ...(opts.contentType !== undefined ? { contentType: opts.contentType } : {}),
      ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}),
      ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
      ...(opts.closed !== undefined ? { closed: opts.closed } : {}),
      ...(opts.body !== undefined
        ? { body: typeof opts.body === "string" ? opts.body : new TextDecoder().decode(opts.body) }
        : {}),
      ...(opts.headers !== undefined ? { callHeaders: opts.headers } : {}),
    }
    const res = yield* Http.put(endpoint, putOpts)
    if (res.status === 200 || res.status === 201) return
    if (res.status === 409) {
      return yield* Effect.fail(new Conflict({ reason: "Stream exists with different config" }))
    }
    return yield* Effect.fail(
      new TransportError({ cause: new Error(`PUT returned status ${res.status}`) }),
    )
  })

export const close = (
  endpoint: Endpoint,
  opts: CloseOptions = {},
): Effect.Effect<{ readonly finalOffset: Offset }, WriteError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const postOpts: Http.PostOptions = {
      body: opts.body !== undefined
        ? (typeof opts.body === "string" ? opts.body : new TextDecoder().decode(opts.body))
        : "",
      streamClosed: true,
      ...(opts.contentType !== undefined ? { contentType: opts.contentType } : {}),
      ...(opts.headers !== undefined ? { callHeaders: opts.headers } : {}),
    }
    const res = yield* Http.post(endpoint, postOpts)
    if (res.status === 200 || res.status === 204) {
      return { finalOffset: res.nextOffset }
    }
    if (res.status === 404) {
      return yield* Effect.fail(new NotFound({ url: String(endpoint.url) }))
    }
    return yield* Effect.fail(
      new TransportError({ cause: new Error(`Close returned status ${res.status}`) }),
    )
  })

export const del = (
  endpoint: Endpoint,
  callHeaders?: HeadersRecord,
): Effect.Effect<void, TransportError | NotFound, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const res = yield* Http.del(endpoint, callHeaders)
    if (res.status === 200 || res.status === 204) return
    if (res.status === 404) return yield* Effect.fail(new NotFound({ url: String(endpoint.url) }))
    return yield* Effect.fail(
      new TransportError({ cause: new Error(`DELETE returned status ${res.status}`) }),
    )
  })
