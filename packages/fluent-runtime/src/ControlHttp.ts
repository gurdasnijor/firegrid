import { Context, Data, Effect, Layer } from "effect"
import {
  addressedInputEventName,
  FluentControlSurface,
  type EntityProjection,
  type SendAddressedInputResult,
} from "./ControlSurface.ts"
import type { FluentRuntimeError } from "./Store.ts"

export class FluentControlHttpError extends Data.TaggedError("FluentControlHttpError")<{
  readonly message: string
  readonly status: number
  readonly cause?: unknown
}> {}

export class FluentControlHttp extends Context.Tag(
  "@firegrid/fluent-runtime/ControlHttp/FluentControlHttp",
)<FluentControlHttp, {
  readonly handle: (
    request: Request,
  ) => Effect.Effect<Response, FluentControlHttpError | FluentRuntimeError>
}>() {}

const jsonResponse = (
  body: unknown,
  init?: ResponseInit,
): Response =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  })

const errorResponse = (
  error: FluentControlHttpError,
): Response =>
  jsonResponse({ error: error.message }, { status: error.status })

const parsePath = (
  request: Request,
): { readonly entityId: string; readonly operation: "send" | "read" | "head" } | undefined => {
  const url = new URL(request.url)
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)
  if (parts.length === 3 && parts[0] === "entities" && parts[2] === "inputs") {
    return { entityId: parts[1] ?? "", operation: "send" }
  }
  if (parts.length === 2 && parts[0] === "entities") {
    return {
      entityId: parts[1] ?? "",
      operation: request.method.toUpperCase() === "HEAD" ? "head" : "read",
    }
  }
  return undefined
}

const readJsonRecord = (
  request: Request,
) =>
  Effect.tryPromise({
    try: () =>
      request.json().then((body: unknown) => {
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          throw new FluentControlHttpError({
            message: "expected JSON object body",
            status: 400,
          })
        }
        return body as Readonly<Record<string, unknown>>
      }),
    catch: cause =>
      cause instanceof FluentControlHttpError
        ? cause
        : new FluentControlHttpError({
          message: "invalid JSON body",
          status: 400,
          cause,
        }),
  })

const sendResponse = (
  result: SendAddressedInputResult,
): Response =>
  jsonResponse({
    entityId: result.entityId,
    eventName: result.eventName,
    appendResult: result.write._tag,
    offset: result.write.offset,
    delivery: result.delivery,
  }, { status: result.write._tag === "Duplicate" ? 200 : 202 })

const projectionResponse = (
  projection: EntityProjection,
): Response =>
  jsonResponse({
    entityId: projection.entityId,
    events: projection.events.length,
    addressedInputs: projection.addressedInputs,
    lastAddressedInput: projection.lastAddressedInput,
    head: {
      offset: projection.head.offset,
      streamClosed: projection.head.streamClosed,
      contentType: projection.head.contentType,
    },
  })

export const makeFluentControlHttp = (
  control: Context.Tag.Service<typeof FluentControlSurface>,
): Context.Tag.Service<typeof FluentControlHttp> => ({
  handle: (request) =>
    Effect.gen(function*() {
      const parsed = parsePath(request)
      if (parsed === undefined || parsed.entityId === "") {
        return yield* new FluentControlHttpError({
          message: "not found",
          status: 404,
        })
      }

      const method = request.method.toUpperCase()
      if (parsed.operation === "send") {
        if (method !== "POST") {
          return yield* new FluentControlHttpError({
            message: "method not allowed",
            status: 405,
          })
        }
        const body = yield* readJsonRecord(request)
        const inputId = body["inputId"]
        if (typeof inputId !== "string" || inputId === "") {
          return yield* new FluentControlHttpError({
            message: "inputId is required",
            status: 400,
          })
        }
        const result = yield* control.sendAddressedInput({
          entityId: parsed.entityId,
          inputId,
          input: body["input"],
        })
        return sendResponse(result)
      }

      if (method === "GET") {
        const projection = yield* control.readEntity(parsed.entityId)
        return projectionResponse(projection)
      }
      if (method === "HEAD") {
        const head = yield* control.headEntity(parsed.entityId)
        return new Response(null, {
          status: 204,
          headers: {
            "fluent-control-offset": head.offset,
            "fluent-control-stream-closed": String(head.streamClosed),
          },
        })
      }
      return yield* new FluentControlHttpError({
        message: "method not allowed",
        status: 405,
      })
    }).pipe(
      Effect.catchTag("FluentControlHttpError", error => Effect.succeed(errorResponse(error))),
      Effect.tap(() =>
        Effect.annotateCurrentSpan({
          "fluent_runtime.control_http.method": request.method.toUpperCase(),
          "fluent_runtime.control_http.path": new URL(request.url).pathname,
        }),
      ),
      Effect.withSpan("fluent_runtime.control_http.request", {
        attributes: {
          "fluent_runtime.control_http.method": request.method.toUpperCase(),
          "fluent_runtime.control_http.path": new URL(request.url).pathname,
          "fluent_runtime.control.event_name": addressedInputEventName,
        },
      }),
    ),
})

export const FluentControlHttpLive = Layer.effect(
  FluentControlHttp,
  Effect.gen(function*() {
    const control = yield* FluentControlSurface
    return makeFluentControlHttp(control)
  }),
)
