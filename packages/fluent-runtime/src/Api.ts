import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "@effect/platform"
import { Effect, Layer, Schema } from "effect"
import { SessionEventSchema, TurnEventSchema } from "./Domain.ts"
import { FluentStore } from "./Store.ts"

const sessionIdParam = HttpApiSchema.param("sessionId", Schema.String)
const turnIdParam = HttpApiSchema.param("turnId", Schema.String)
const timerIdParam = HttpApiSchema.param("timerId", Schema.String)
const waitIdParam = HttpApiSchema.param("waitId", Schema.String)
const entityIdParam = HttpApiSchema.param("entityId", Schema.String)

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

const SleepPayloadSchema = Schema.Struct({
  timerId: Schema.String,
  fireAtEpochMs: Schema.Number,
})

const SleepResultSchema = Schema.Struct({
  status: Schema.Literal("pending", "fired"),
  sessionId: Schema.String,
  turnId: Schema.String,
  timerId: Schema.String,
  eventsUrl: Schema.String,
  fireAtEpochMs: Schema.Number,
  firedAtEpochMs: Schema.optional(Schema.Number),
})

const FireTimerPayloadSchema = Schema.Struct({
  firedAtEpochMs: Schema.Number,
})

const FireTimerResultSchema = Schema.Struct({
  sessionId: Schema.String,
  turnId: Schema.String,
  timerId: Schema.String,
  eventsUrl: Schema.String,
  write: Schema.Literal("appended", "duplicate"),
})

const WaitPayloadSchema = Schema.Struct({
  waitId: Schema.String,
  predicate: Schema.String,
  afterOffset: Schema.String,
  self: Schema.optional(Schema.Unknown),
})

const WaitResultSchema = Schema.Struct({
  status: Schema.Literal("pending", "matched"),
  sessionId: Schema.String,
  turnId: Schema.String,
  waitId: Schema.String,
  eventsUrl: Schema.String,
  predicate: Schema.String,
  afterOffset: Schema.String,
  matchedOffset: Schema.optional(Schema.String),
  event: Schema.optional(Schema.Unknown),
})

const MatchWaitPayloadSchema = Schema.Struct({
  matchedOffset: Schema.String,
  event: Schema.Unknown,
})

const MatchWaitResultSchema = Schema.Struct({
  sessionId: Schema.String,
  turnId: Schema.String,
  waitId: Schema.String,
  eventsUrl: Schema.String,
  write: Schema.Literal("appended", "duplicate", "not_matched"),
})

// ── Control-plane (entity) surface — product spelling over durable stream
// facts. send/tag/fork/read/head map onto FluentStore primitives; the entity id
// addresses a session stream. `tag` names a durable point by capturing the
// current head offset (no extra store state); that offset is the address `fork`
// branches from.
const SendPayloadSchema = Schema.Struct({
  name: Schema.String,
  payload: Schema.Unknown,
})

const SendResultSchema = Schema.Struct({
  entityId: Schema.String,
  eventsUrl: Schema.String,
})

const TagPayloadSchema = Schema.Struct({
  name: Schema.String,
})

const TagResultSchema = Schema.Struct({
  entityId: Schema.String,
  name: Schema.String,
  offset: Schema.String,
})

const ForkPayloadSchema = Schema.Struct({
  childEntityId: Schema.String,
  forkOffset: Schema.String,
})

const ForkResultSchema = Schema.Struct({
  status: Schema.Literal("forked", "unsupported"),
  parentEntityId: Schema.String,
  childEntityId: Schema.String,
  reason: Schema.optional(Schema.String),
})

const EntityReadSchema = Schema.Struct({
  entityId: Schema.String,
  eventsUrl: Schema.String,
  events: Schema.Array(SessionEventSchema),
})

const EntityHeadSchema = Schema.Struct({
  entityId: Schema.String,
  offset: Schema.String,
  streamClosed: Schema.Boolean,
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

const writeStatus = (
  tag: "Appended" | "Duplicate",
): "appended" | "duplicate" =>
  tag === "Appended" ? "appended" : "duplicate"

const entityTag = (entityId: string, offset: string) => ({
  entityId,
  offset,
})

const entityHead = (
  entityId: string,
  offset: string,
  streamClosed: boolean,
) => ({
  entityId,
  offset,
  streamClosed,
})

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
  .add(
    HttpApiEndpoint.post("sleep")`/${sessionIdParam}/turns/${turnIdParam}/sleep`
      .setPayload(SleepPayloadSchema)
      .addSuccess(SleepResultSchema)
      .addError(RuntimeFailure),
  )
  .add(
    HttpApiEndpoint.post("fireTimer")`/${sessionIdParam}/turns/${turnIdParam}/timers/${timerIdParam}/fire`
      .setPayload(FireTimerPayloadSchema)
      .addSuccess(FireTimerResultSchema)
      .addError(RuntimeFailure),
  )
  .add(
    HttpApiEndpoint.post("wait")`/${sessionIdParam}/turns/${turnIdParam}/waits`
      .setPayload(WaitPayloadSchema)
      .addSuccess(WaitResultSchema)
      .addError(RuntimeFailure),
  )
  .add(
    HttpApiEndpoint.post("matchWait")`/${sessionIdParam}/turns/${turnIdParam}/waits/${waitIdParam}/match`
      .setPayload(MatchWaitPayloadSchema)
      .addSuccess(MatchWaitResultSchema)
      .addError(RuntimeFailure),
  )
  .prefix("/sessions")
{}

export class ControlPlaneApi extends HttpApiGroup.make("ControlPlane")
  .add(
    HttpApiEndpoint.post("send")`/${entityIdParam}/send`
      .setPayload(SendPayloadSchema)
      .addSuccess(SendResultSchema)
      .addError(RuntimeFailure),
  )
  .add(
    HttpApiEndpoint.post("tag")`/${entityIdParam}/tag`
      .setPayload(TagPayloadSchema)
      .addSuccess(TagResultSchema)
      .addError(RuntimeFailure),
  )
  .add(
    HttpApiEndpoint.post("fork")`/${entityIdParam}/fork`
      .setPayload(ForkPayloadSchema)
      .addSuccess(ForkResultSchema)
      .addError(RuntimeFailure),
  )
  .add(
    HttpApiEndpoint.get("read")`/${entityIdParam}`
      .addSuccess(EntityReadSchema)
      .addError(RuntimeFailure),
  )
  .add(
    HttpApiEndpoint.get("head")`/${entityIdParam}/head`
      .addSuccess(EntityHeadSchema)
      .addError(RuntimeFailure),
  )
  .prefix("/entities")
{}

export class FluentRuntimeApi extends HttpApi.make("FluentRuntime")
  .add(SessionsApi)
  .add(ControlPlaneApi)
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
        }))
      .handle("sleep", ({ path, payload }) =>
        Effect.gen(function* () {
          const store = yield* FluentStore
          const result = yield* mapRuntimeFailure(store.durableSleep({
            sessionId: path.sessionId,
            turnId: path.turnId,
            timerId: payload.timerId,
            fireAtEpochMs: payload.fireAtEpochMs,
          }))
          const base = {
            sessionId: result.turn.sessionId,
            turnId: result.turn.turnId,
            timerId: result.scheduled.timerId,
            eventsUrl: result.turn.eventsUrl,
            fireAtEpochMs: result.scheduled.fireAtEpochMs,
          }
          return result._tag === "Pending"
            ? { ...base, status: "pending" as const }
            : {
              ...base,
              status: "fired" as const,
              firedAtEpochMs: result.fired.firedAtEpochMs,
            }
        }))
      .handle("fireTimer", ({ path, payload }) =>
        Effect.gen(function* () {
          const store = yield* FluentStore
          const result = yield* mapRuntimeFailure(store.fireTurnTimer({
            sessionId: path.sessionId,
            turnId: path.turnId,
            timerId: path.timerId,
            firedAtEpochMs: payload.firedAtEpochMs,
          }))
          return {
            sessionId: result.turn.sessionId,
            turnId: result.turn.turnId,
            timerId: path.timerId,
            eventsUrl: result.turn.eventsUrl,
            write: writeStatus(result.write._tag),
          }
        }))
      .handle("wait", ({ path, payload }) =>
        Effect.gen(function* () {
          const store = yield* FluentStore
          const result = yield* mapRuntimeFailure(store.durableWait({
            sessionId: path.sessionId,
            turnId: path.turnId,
            waitId: payload.waitId,
            predicate: payload.predicate,
            afterOffset: payload.afterOffset,
            ...(payload.self === undefined ? {} : { self: payload.self }),
          }))
          const base = {
            sessionId: result.turn.sessionId,
            turnId: result.turn.turnId,
            waitId: result.registered.waitId,
            eventsUrl: result.turn.eventsUrl,
            predicate: result.registered.predicate,
            afterOffset: result.registered.afterOffset,
          }
          return result._tag === "Pending"
            ? { ...base, status: "pending" as const }
            : {
              ...base,
              status: "matched" as const,
              matchedOffset: result.matched.matchedOffset,
              event: result.matched.event,
            }
        }))
      .handle("matchWait", ({ path, payload }) =>
        Effect.gen(function* () {
          const store = yield* FluentStore
          const result = yield* mapRuntimeFailure(store.matchTurnWait({
            sessionId: path.sessionId,
            turnId: path.turnId,
            waitId: path.waitId,
            matchedOffset: payload.matchedOffset,
            event: payload.event,
          }))
          if (result._tag === "NotMatched") {
            return {
              sessionId: result.turn.sessionId,
              turnId: result.turn.turnId,
              waitId: result.registered.waitId,
              eventsUrl: result.turn.eventsUrl,
              write: "not_matched" as const,
            }
          }
          return {
            sessionId: result.turn.sessionId,
            turnId: result.turn.turnId,
            waitId: path.waitId,
            eventsUrl: result.turn.eventsUrl,
            write: writeStatus(result.write._tag),
          }
        })),
)

export const ControlPlaneApiLive = HttpApiBuilder.group(
  FluentRuntimeApi,
  "ControlPlane",
  (handlers) =>
    handlers
      .handle("send", ({ path, payload }) =>
        Effect.gen(function* () {
          const store = yield* FluentStore
          const handle = yield* mapRuntimeFailure(store.appendSessionEvent({
            sessionId: path.entityId,
            name: payload.name,
            payload: payload.payload,
          }))
          return { entityId: handle.sessionId, eventsUrl: handle.eventsUrl }
        }))
      .handle("tag", ({ path, payload }) =>
        Effect.gen(function* () {
          const store = yield* FluentStore
          const head = yield* mapRuntimeFailure(store.headSession(path.entityId))
          return { ...entityTag(path.entityId, head.offset), name: payload.name }
        }))
      .handle("fork", ({ path, payload }) =>
        Effect.gen(function* () {
          const store = yield* FluentStore
          const result = yield* store.forkSession({
            parentSessionId: path.entityId,
            childSessionId: payload.childEntityId,
            forkOffset: payload.forkOffset,
          })
          return result._tag === "Forked"
            ? {
              status: "forked" as const,
              parentEntityId: result.parent.sessionId,
              childEntityId: result.child.sessionId,
            }
            : {
              status: "unsupported" as const,
              parentEntityId: result.parent.sessionId,
              childEntityId: result.child.sessionId,
              reason: result.reason,
            }
        }))
      .handle("read", ({ path }) =>
        Effect.gen(function* () {
          const store = yield* FluentStore
          const events = yield* mapRuntimeFailure(store.collectSession(path.entityId))
          return {
            entityId: path.entityId,
            eventsUrl: store.sessionUrl(path.entityId),
            events,
          }
        }))
      .handle("head", ({ path }) =>
        Effect.gen(function* () {
          const store = yield* FluentStore
          const head = yield* mapRuntimeFailure(store.headSession(path.entityId))
          return entityHead(path.entityId, head.offset, head.streamClosed)
        })),
)

export const FluentRuntimeApiLive = HttpApiBuilder.api(FluentRuntimeApi).pipe(
  Layer.provide(SessionsApiLive),
  Layer.provide(ControlPlaneApiLive),
)
