/**
 * The thin HTTP binding — the airgap edge (tf-r06u.33, confirmed scope: Core +
 * thin HttpApi binding). Three routes mirror the three verbs; each reads the
 * single Bearer, delegates to {@link EdgeAuthResolver}, and maps the closed
 * error surface to HTTP status. It carries NO business logic and NO durable-
 * streams URL — it is an authorizing reverse-proxy, not a gateway.
 *
 *   POST /open                -> { intent, output, startOffset }   (DECIDE-1)
 *   POST /append/:handle      -> { offset, deduplicated }          (intent in)
 *   GET  /read/:handle?offset -> { events, nextOffset, upToDate }  (output out)
 *
 * The client only ever holds opaque handles (in the path) + one Bearer (in the
 * header). It never sees a stream name, table, or the DS base URL. Built on
 * `HttpRouter` so it is exercisable via `HttpApp.toWebHandler` without binding
 * a port — the e2e validation substrate for this slice.
 */
import {
  Headers,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform"
import { Effect, Option, Schema } from "effect"
import { type AuthError, EdgeAuthResolver } from "./resolver.ts"
import { type OpaqueHandle, OpenRequestSchema } from "./schema.ts"

const STREAM_NEXT_OFFSET_HEADER = "stream-next-offset"
const BEARER_PREFIX = "Bearer "

/**
 * Opaque handles ride a `:handle` path param. They are signed envelopes
 * (~180+ chars), so the router's `maxParamLength` must be raised well above
 * find-my-way's default of 100 — otherwise a valid handle silently fails to
 * match and 404s. Bounded (not unbounded) so pathological input is still
 * rejected. Baked into {@link EdgeAuthHttpApp} so a consumer cannot forget it.
 */
export const EDGE_AUTH_MAX_HANDLE_LENGTH = 4096

/** Map the closed auth-error surface to status. Authentication problems are
 * 401; authorization (you authenticated but may not do this) is 403. */
const authStatus = (error: AuthError): 401 | 403 => {
  switch (error.reason) {
    case "bad-token":
    case "expired":
    case "revoked":
      return 401
    case "bad-handle":
    case "tenant-mismatch":
    case "grant-denied":
      return 403
  }
}

const denied = (status: number, reason: string) =>
  HttpServerResponse.unsafeJson({ error: reason }, { status })

/** Pull the Bearer token from the Authorization header. */
const bearer = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const header = Headers.get(request.headers, "authorization")
  return Option.flatMap(header, (value) =>
    value.startsWith(BEARER_PREFIX)
      ? Option.some(value.slice(BEARER_PREFIX.length))
      : Option.none())
})

/** The opaque handle path segment, as a branded handle (the resolver verifies
 * its signature — this is only the transport-level non-empty guard). */
const handleParam = Effect.gen(function*() {
  const { params } = yield* HttpRouter.RouteContext
  const raw = params.handle
  return raw !== undefined && raw.length > 0
    ? Option.some(raw as OpaqueHandle)
    : Option.none<OpaqueHandle>()
})

/** `?offset=` — absent or empty means read-from-beginning (Option.none). */
const offsetParam = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const url = new URL(request.url, "http://edge-auth.local")
  const raw = url.searchParams.get("offset")
  return raw !== null && raw.length > 0 ? Option.some(raw) : Option.none<string>()
})

const openRoute = Effect.gen(function*() {
  const resolver = yield* EdgeAuthResolver
  const token = yield* bearer
  if (Option.isNone(token)) return denied(401, "bad-token")

  const request = yield* HttpServerRequest.schemaBodyJson(OpenRequestSchema).pipe(
    Effect.option,
  )
  if (Option.isNone(request)) return denied(400, "bad-request")

  return yield* resolver.verifyToken(token.value).pipe(
    Effect.flatMap((claims) => resolver.open(claims, request.value)),
    Effect.map((result) => HttpServerResponse.unsafeJson(result)),
    Effect.catchTag("edge-auth/AuthError", (e) =>
      Effect.succeed(denied(authStatus(e), e.reason))),
    Effect.catchTag("edge-auth/ForwardError", () =>
      Effect.succeed(denied(502, "upstream-error"))),
  )
})

const appendRoute = Effect.gen(function*() {
  const resolver = yield* EdgeAuthResolver
  const token = yield* bearer
  if (Option.isNone(token)) return denied(401, "bad-token")
  const handle = yield* handleParam
  if (Option.isNone(handle)) return denied(400, "bad-handle")

  // The intent payload is forwarded verbatim — the resolver does not interpret
  // it (that is the host intent-observer's job, tf-r06u.42).
  const body = yield* HttpServerRequest.schemaBodyJson(Schema.Unknown).pipe(
    Effect.option,
  )
  if (Option.isNone(body)) return denied(400, "bad-request")

  return yield* resolver.verifyToken(token.value).pipe(
    Effect.flatMap((claims) => resolver.append(claims, handle.value, body.value)),
    Effect.map((result) => HttpServerResponse.unsafeJson(result)),
    Effect.catchTag("edge-auth/AuthError", (e) =>
      Effect.succeed(denied(authStatus(e), e.reason))),
    Effect.catchTag("edge-auth/ForwardError", () =>
      Effect.succeed(denied(502, "upstream-error"))),
  )
})

const readRoute = Effect.gen(function*() {
  const resolver = yield* EdgeAuthResolver
  const token = yield* bearer
  if (Option.isNone(token)) return denied(401, "bad-token")
  const handle = yield* handleParam
  if (Option.isNone(handle)) return denied(400, "bad-handle")
  const offset = yield* offsetParam

  return yield* resolver.verifyToken(token.value).pipe(
    Effect.flatMap((claims) => resolver.read(claims, handle.value, offset)),
    Effect.map((result) =>
      HttpServerResponse.setHeader(
        HttpServerResponse.unsafeJson(result),
        STREAM_NEXT_OFFSET_HEADER,
        result.nextOffset,
      )),
    Effect.catchTag("edge-auth/AuthError", (e) =>
      Effect.succeed(denied(authStatus(e), e.reason))),
    // 410 Gone -> the edge resyncs from a fresh handle (consumer-contract §5.2;
    // richer resync entry point is tf-r06u.43), NOT a fatal error.
    Effect.catchTag("edge-auth/ForwardGone", () =>
      Effect.succeed(denied(410, "gone"))),
    Effect.catchTag("edge-auth/ForwardError", () =>
      Effect.succeed(denied(502, "upstream-error"))),
  )
})

/**
 * The edge-auth HTTP routes (raw router, for composition). If mounted under a
 * parent router, ensure that router's `maxParamLength` is >=
 * {@link EDGE_AUTH_MAX_HANDLE_LENGTH}.
 */
export const EdgeAuthHttpRouter = HttpRouter.empty.pipe(
  HttpRouter.post("/open", openRoute),
  HttpRouter.post("/append/:handle", appendRoute),
  HttpRouter.get("/read/:handle", readRoute),
)

/**
 * Serve-ready app: the routes with `maxParamLength` baked in so opaque handles
 * fit the `:handle` param. Provide `EdgeAuthResolverLive` (+ deps) and serve
 * via `@effect/platform` `HttpServer`, or test via `HttpApp.toWebHandler`.
 */
export const EdgeAuthHttpApp = HttpRouter.withRouterConfig(EdgeAuthHttpRouter, {
  maxParamLength: EDGE_AUTH_MAX_HANDLE_LENGTH,
})
