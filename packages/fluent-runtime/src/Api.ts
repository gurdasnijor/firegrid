import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "@effect/platform"
import { Effect, Layer, Schema } from "effect"
import { SessionEventSchema, TurnEventSchema } from "./Domain.ts"
import { FluentSources } from "./Sources.ts"
import { FluentStore } from "./Store.ts"

const sessionIdParam = HttpApiSchema.param("sessionId", Schema.String)
const turnIdParam = HttpApiSchema.param("turnId", Schema.String)
const timerIdParam = HttpApiSchema.param("timerId", Schema.String)
const waitIdParam = HttpApiSchema.param("waitId", Schema.String)
const entityIdParam = HttpApiSchema.param("entityId", Schema.String)
const childEntityIdParam = HttpApiSchema.param("childEntityId", Schema.String)

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

const FireDueTimersPayloadSchema = Schema.Struct({
  nowEpochMs: Schema.Number,
})

const FireDueTimersResultSchema = Schema.Struct({
  sessionId: Schema.String,
  turnId: Schema.String,
  eventsUrl: Schema.String,
  fired: Schema.Array(Schema.Struct({
    timerId: Schema.String,
    fireAtEpochMs: Schema.Number,
    firedAtEpochMs: Schema.Number,
    write: Schema.Literal("appended", "duplicate"),
  })),
  pending: Schema.Array(Schema.Struct({
    timerId: Schema.String,
    fireAtEpochMs: Schema.Number,
  })),
  alreadyFired: Schema.Array(Schema.Struct({
    timerId: Schema.String,
    fireAtEpochMs: Schema.Number,
    firedAtEpochMs: Schema.Number,
  })),
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

const MatchPendingWaitsResultSchema = Schema.Struct({
  sessionId: Schema.String,
  turnId: Schema.String,
  eventsUrl: Schema.String,
  matched: Schema.Array(Schema.Struct({
    waitId: Schema.String,
    write: Schema.Literal("appended", "duplicate"),
  })),
  notMatched: Schema.Array(Schema.Struct({
    waitId: Schema.String,
  })),
  alreadyMatched: Schema.Array(Schema.Struct({
    waitId: Schema.String,
    matchedOffset: Schema.String,
  })),
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

const SpawnTaskSchema = Schema.Struct({
  prompt: Schema.String,
})

const SpawnPayloadSchema = Schema.Struct({
  toolCallId: Schema.String,
  slot: Schema.Number,
  prompt: Schema.String,
})

const SpawnChildResultSchema = Schema.Struct({
  parentEntityId: Schema.String,
  childEntityId: Schema.String,
  forkOffset: Schema.String,
  eventsUrl: Schema.String,
  initialWrite: Schema.Literal("appended", "duplicate"),
})

const SpawnAllPayloadSchema = Schema.Struct({
  toolCallId: Schema.String,
  tasks: Schema.Array(SpawnTaskSchema),
})

const SpawnAllResultSchema = Schema.Struct({
  parentEntityId: Schema.String,
  children: Schema.Array(SpawnChildResultSchema),
})

const ChildResultPayloadSchema = Schema.Struct({
  resultId: Schema.String,
  result: Schema.Unknown,
})

const ChildResultResultSchema = Schema.Struct({
  childEntityId: Schema.String,
  write: Schema.Literal("appended", "duplicate"),
})

const JoinChildPayloadSchema = Schema.Struct({
  turnId: Schema.String,
  childEntityId: Schema.String,
  resultId: Schema.String,
  waitId: Schema.optional(Schema.String),
})

const JoinChildResultSchema = Schema.Struct({
  status: Schema.Literal("pending", "matched"),
  parentEntityId: Schema.String,
  turnId: Schema.String,
  childEntityId: Schema.String,
  resultId: Schema.String,
  event: Schema.optional(Schema.Unknown),
})

const RaceWinnerPayloadSchema = Schema.Struct({
  raceId: Schema.String,
  winnerChildEntityId: Schema.String,
  loserPolicy: Schema.Literal("let_finish", "cancel"),
})

const RaceWinnerResultSchema = Schema.Struct({
  parentEntityId: Schema.String,
  raceId: Schema.String,
  winnerChildEntityId: Schema.String,
  loserPolicy: Schema.Literal("let_finish", "cancel"),
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

const spawnChildResult = (parentEntityId: string, result: {
  readonly childSessionId: string
  readonly child: { readonly eventsUrl: string }
  readonly forkOffset: string
  readonly initialWrite: { readonly _tag: "Appended" | "Duplicate" }
}) => ({
  parentEntityId,
  childEntityId: result.childSessionId,
  forkOffset: result.forkOffset,
  eventsUrl: result.child.eventsUrl,
  initialWrite: writeStatus(result.initialWrite._tag),
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
    HttpApiEndpoint.post("fireDueTimers")`/${sessionIdParam}/turns/${turnIdParam}/timers/fire-due`
      .setPayload(FireDueTimersPayloadSchema)
      .addSuccess(FireDueTimersResultSchema)
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
  .add(
    HttpApiEndpoint.post("matchPendingWaits")`/${sessionIdParam}/turns/${turnIdParam}/waits/match`
      .setPayload(MatchWaitPayloadSchema)
      .addSuccess(MatchPendingWaitsResultSchema)
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
    HttpApiEndpoint.post("spawn")`/${entityIdParam}/spawn`
      .setPayload(SpawnPayloadSchema)
      .addSuccess(SpawnChildResultSchema)
      .addError(RuntimeFailure),
  )
  .add(
    HttpApiEndpoint.post("spawnAll")`/${entityIdParam}/spawn_all`
      .setPayload(SpawnAllPayloadSchema)
      .addSuccess(SpawnAllResultSchema)
      .addError(RuntimeFailure),
  )
  .add(
    HttpApiEndpoint.post("publishChildResult")`/${entityIdParam}/children/${childEntityIdParam}/result`
      .setPayload(ChildResultPayloadSchema)
      .addSuccess(ChildResultResultSchema)
      .addError(RuntimeFailure),
  )
  .add(
    HttpApiEndpoint.post("joinChild")`/${entityIdParam}/children/join`
      .setPayload(JoinChildPayloadSchema)
      .addSuccess(JoinChildResultSchema)
      .addError(RuntimeFailure),
  )
  .add(
    HttpApiEndpoint.post("raceWinner")`/${entityIdParam}/children/race-winner`
      .setPayload(RaceWinnerPayloadSchema)
      .addSuccess(RaceWinnerResultSchema)
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
      .handle("fireDueTimers", ({ path, payload }) =>
        Effect.gen(function* () {
          const sources = yield* FluentSources
          const result = yield* mapRuntimeFailure(sources.fireDueTurnTimers({
            sessionId: path.sessionId,
            turnId: path.turnId,
            nowEpochMs: payload.nowEpochMs,
          }))
          return {
            sessionId: result.turn.sessionId,
            turnId: result.turn.turnId,
            eventsUrl: result.turn.eventsUrl,
            fired: result.fired.map((timer) => ({
              timerId: timer.timerId,
              fireAtEpochMs: timer.fireAtEpochMs,
              firedAtEpochMs: timer.firedAtEpochMs,
              write: writeStatus(timer.write._tag),
            })),
            pending: result.pending,
            alreadyFired: result.alreadyFired,
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
        }))
      .handle("matchPendingWaits", ({ path, payload }) =>
        Effect.gen(function* () {
          const sources = yield* FluentSources
          const result = yield* mapRuntimeFailure(sources.matchPendingTurnWaits({
            sessionId: path.sessionId,
            turnId: path.turnId,
            matchedOffset: payload.matchedOffset,
            event: payload.event,
          }))
          return {
            sessionId: result.turn.sessionId,
            turnId: result.turn.turnId,
            eventsUrl: result.turn.eventsUrl,
            matched: result.matched.map((wait) => ({
              waitId: wait.waitId,
              write: writeStatus(wait.write._tag),
            })),
            notMatched: result.notMatched,
            alreadyMatched: result.alreadyMatched,
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
      .handle("spawn", ({ path, payload }) =>
        Effect.gen(function* () {
          const store = yield* FluentStore
          const result = yield* mapRuntimeFailure(store.spawnChild({
            parentSessionId: path.entityId,
            toolCallId: payload.toolCallId,
            slot: payload.slot,
            prompt: payload.prompt,
          }))
          return spawnChildResult(path.entityId, result)
        }))
      .handle("spawnAll", ({ path, payload }) =>
        Effect.gen(function* () {
          const store = yield* FluentStore
          const result = yield* mapRuntimeFailure(store.spawnAll({
            parentSessionId: path.entityId,
            toolCallId: payload.toolCallId,
            tasks: payload.tasks,
          }))
          return {
            parentEntityId: result.parent.sessionId,
            children: result.children.map(child =>
              spawnChildResult(result.parent.sessionId, child)),
          }
        }))
      .handle("publishChildResult", ({ path, payload }) =>
        Effect.gen(function* () {
          const store = yield* FluentStore
          const result = yield* mapRuntimeFailure(store.publishChildResult({
            parentSessionId: path.entityId,
            childSessionId: path.childEntityId,
            resultId: payload.resultId,
            result: payload.result,
          }))
          return {
            childEntityId: result.child.sessionId,
            write: writeStatus(result.write._tag),
          }
        }))
      .handle("joinChild", ({ path, payload }) =>
        Effect.gen(function* () {
          const store = yield* FluentStore
          const result = yield* mapRuntimeFailure(store.joinChildResult({
            parentSessionId: path.entityId,
            turnId: payload.turnId,
            childSessionId: payload.childEntityId,
            resultId: payload.resultId,
            ...(payload.waitId === undefined ? {} : { waitId: payload.waitId }),
          }))
          return result._tag === "Matched"
            ? {
              status: "matched" as const,
              parentEntityId: path.entityId,
              turnId: result.turn.turnId,
              childEntityId: payload.childEntityId,
              resultId: payload.resultId,
              event: result.childResult,
            }
            : {
              status: "pending" as const,
              parentEntityId: path.entityId,
              turnId: result.turn.turnId,
              childEntityId: payload.childEntityId,
              resultId: payload.resultId,
            }
        }))
      .handle("raceWinner", ({ path, payload }) =>
        Effect.gen(function* () {
          const store = yield* FluentStore
          yield* mapRuntimeFailure(store.recordChildRaceWinner({
            parentSessionId: path.entityId,
            raceId: payload.raceId,
            winnerChildSessionId: payload.winnerChildEntityId,
            loserPolicy: payload.loserPolicy,
          }))
          return {
            parentEntityId: path.entityId,
            raceId: payload.raceId,
            winnerChildEntityId: payload.winnerChildEntityId,
            loserPolicy: payload.loserPolicy,
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
