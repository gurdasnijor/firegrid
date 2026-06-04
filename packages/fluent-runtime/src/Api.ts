import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "@effect/platform"
import { Effect, Layer, Schema } from "effect"
import { TurnEventSchema } from "./Domain.ts"
import { FluentStore } from "./Store.ts"

const sessionIdParam = HttpApiSchema.param("sessionId", Schema.String)
const turnIdParam = HttpApiSchema.param("turnId", Schema.String)

const SessionHandleSchema = Schema.Struct({
  sessionId: Schema.String,
  eventsUrl: Schema.String,
})

const TurnHandleSchema = Schema.Struct({
  sessionId: Schema.String,
  turnId: Schema.String,
  eventsUrl: Schema.String,
})

const CreateSessionPayloadSchema = Schema.Struct({
  sessionId: Schema.String,
  agent: Schema.String,
})

const PromptPayloadSchema = Schema.Struct({
  turnId: Schema.String,
  prompt: Schema.String,
})

const TurnReadSchema = Schema.Struct({
  sessionId: Schema.String,
  turnId: Schema.String,
  eventsUrl: Schema.String,
  streamClosed: Schema.Boolean,
  events: Schema.Array(TurnEventSchema),
})

class RuntimeFailure extends Schema.TaggedError<RuntimeFailure>()(
  "RuntimeFailure",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 500 }),
) {}

const mapRuntimeFailure = <A, E extends { readonly message: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, RuntimeFailure, R> =>
  Effect.mapError(effect, (error) => new RuntimeFailure({ message: error.message }))

export class SessionsApi extends HttpApiGroup.make("Sessions")
  .add(
    HttpApiEndpoint.post("create", "/")
      .setPayload(CreateSessionPayloadSchema)
      .addSuccess(SessionHandleSchema)
      .addError(RuntimeFailure),
  )
  .add(
    HttpApiEndpoint.get("events")`/${sessionIdParam}/events`
      .addSuccess(SessionHandleSchema),
  )
  .add(
    HttpApiEndpoint.post("prompt")`/${sessionIdParam}/turns`
      .setPayload(PromptPayloadSchema)
      .addSuccess(TurnHandleSchema)
      .addError(RuntimeFailure),
  )
  .add(
    HttpApiEndpoint.get("turn")`/${sessionIdParam}/turns/${turnIdParam}`
      .addSuccess(TurnReadSchema)
      .addError(RuntimeFailure),
  )
  .prefix("/sessions")
{}

export class FluentRuntimeApi extends HttpApi.make("FluentRuntime")
  .add(SessionsApi)
{}

export const SessionsApiLive = HttpApiBuilder.group(
  FluentRuntimeApi,
  "Sessions",
  (handlers) =>
    handlers
      .handle("create", ({ payload }) =>
        Effect.gen(function* () {
          const store = yield* FluentStore
          return yield* mapRuntimeFailure(store.createSession(payload))
        }))
      .handle("events", ({ path }) =>
        Effect.gen(function* () {
          const store = yield* FluentStore
          return {
            sessionId: path.sessionId,
            eventsUrl: store.sessionUrl(path.sessionId),
          }
        }))
      .handle("prompt", ({ path, payload }) =>
        Effect.gen(function* () {
          const store = yield* FluentStore
          return yield* mapRuntimeFailure(store.startTurn({
            sessionId: path.sessionId,
            turnId: payload.turnId,
            prompt: payload.prompt,
          }))
        }))
      .handle("turn", ({ path }) =>
        Effect.gen(function* () {
          const store = yield* FluentStore
          const read = yield* mapRuntimeFailure(
            store.readTurn(path.sessionId, path.turnId),
          )
          return {
            sessionId: read.turn.sessionId,
            turnId: read.turn.turnId,
            eventsUrl: read.turn.eventsUrl,
            streamClosed: read.streamClosed,
            events: read.events,
          }
        })),
)

export const FluentRuntimeApiLive = HttpApiBuilder.api(FluentRuntimeApi).pipe(
  Layer.provide(SessionsApiLive),
)
