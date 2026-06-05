import { HttpClient } from "@effect/platform"
import { Environment } from "@marcbachmann/cel-js"
import { Context, Data, Effect, Layer } from "effect"
import {
  DurableStream,
  type Endpoint,
  type HeadResult,
  type ProducerAppendResult,
} from "effect-durable-streams"
import {
  SessionEventSchema,
  TurnEventSchema,
  type SessionEvent,
  type SessionHandle,
  type SessionId,
  type SessionChildResultEvent,
  type StateChangeMessage,
  type TimerId,
  type TurnEvent,
  type TurnTimerFiredEvent,
  type TurnTimerScheduledEvent,
  type TurnHandle,
  type TurnId,
  type TurnWaitMatchedEvent,
  type TurnWaitRegisteredEvent,
  type WaitId,
} from "./Domain.ts"

export class FluentRuntimeError extends Data.TaggedError("FluentRuntimeError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface StoreConfig {
  readonly durableStreamsBaseUrl: string
  readonly namespace: string
}

export interface CreateSessionInput {
  readonly sessionId: SessionId
  readonly agent: string
}

export interface AppendSessionEventInput {
  readonly sessionId: SessionId
  readonly name: string
  readonly payload: unknown
}

export interface ProducerFence {
  readonly producerId: string
  readonly epoch: number
  readonly seq: number
}

export interface AppendSessionEventFencedInput extends AppendSessionEventInput {
  readonly fence: ProducerFence
}

export interface AppendSessionEventFencedResult {
  readonly handle: SessionHandle
  readonly write: ProducerAppendResult
}

export interface AppendStateChangeFencedInput {
  readonly sessionId: SessionId
  readonly change: StateChangeMessage
  readonly fence: ProducerFence
}

export interface AppendStateChangeFencedResult {
  readonly handle: SessionHandle
  readonly write: ProducerAppendResult
  readonly change: StateChangeMessage
}

export interface StartTurnInput {
  readonly sessionId: SessionId
  readonly turnId: TurnId
  readonly prompt: string
}

export interface CompleteTurnInput {
  readonly sessionId: SessionId
  readonly turnId: TurnId
  readonly result: unknown
}

export interface FailTurnInput {
  readonly sessionId: SessionId
  readonly turnId: TurnId
  readonly message: string
}

export interface ScheduleTurnTimerInput {
  readonly sessionId: SessionId
  readonly turnId: TurnId
  readonly timerId: TimerId
  readonly fireAtEpochMs: number
}

export interface ScheduleTurnTimerResult {
  readonly turn: TurnHandle
  readonly write: ProducerAppendResult
}

export interface FireTurnTimerInput {
  readonly sessionId: SessionId
  readonly turnId: TurnId
  readonly timerId: TimerId
  readonly firedAtEpochMs: number
}

export interface FireTurnTimerResult {
  readonly turn: TurnHandle
  readonly write: ProducerAppendResult
}

export type TurnTimerWaitResult =
  | {
    readonly _tag: "Pending"
    readonly turn: TurnHandle
    readonly scheduled: TurnTimerScheduledEvent
  }
  | {
    readonly _tag: "Fired"
    readonly turn: TurnHandle
    readonly scheduled: TurnTimerScheduledEvent
    readonly fired: TurnTimerFiredEvent
  }

export interface RegisterTurnWaitInput {
  readonly sessionId: SessionId
  readonly turnId: TurnId
  readonly waitId: WaitId
  readonly predicate: string
  readonly afterOffset: string
  readonly self?: unknown
}

export interface RegisterTurnWaitResult {
  readonly turn: TurnHandle
  readonly write: ProducerAppendResult
}

export interface MatchTurnWaitInput {
  readonly sessionId: SessionId
  readonly turnId: TurnId
  readonly waitId: WaitId
  readonly matchedOffset: string
  readonly event: unknown
}

export type MatchTurnWaitResult =
  | {
    readonly _tag: "Matched"
    readonly turn: TurnHandle
    readonly write: ProducerAppendResult
  }
  | {
    readonly _tag: "NotMatched"
    readonly turn: TurnHandle
    readonly registered: TurnWaitRegisteredEvent
  }

export type TurnWaitResult =
  | {
    readonly _tag: "Pending"
    readonly turn: TurnHandle
    readonly registered: TurnWaitRegisteredEvent
  }
  | {
    readonly _tag: "Matched"
    readonly turn: TurnHandle
    readonly registered: TurnWaitRegisteredEvent
    readonly matched: TurnWaitMatchedEvent
  }

export interface ReadTurnResult {
  readonly turn: TurnHandle
  readonly events: ReadonlyArray<TurnEvent>
  readonly head: HeadResult
  readonly streamClosed: boolean
}

export interface ForkSessionInput {
  readonly parentSessionId: SessionId
  readonly childSessionId: SessionId
  readonly forkOffset: string
}

export type ForkSessionResult =
  | {
    readonly _tag: "Forked"
    readonly parent: SessionHandle
    readonly child: SessionHandle
  }
  | {
    readonly _tag: "Unsupported"
    readonly parent: SessionHandle
    readonly child: SessionHandle
    readonly reason: string
  }

export interface SpawnChildTask {
  readonly prompt: string
}

export interface SpawnChildInput extends SpawnChildTask {
  readonly parentSessionId: SessionId
  readonly toolCallId: string
  readonly slot: number
}

export interface SpawnChildResult {
  readonly parent: SessionHandle
  readonly child: SessionHandle
  readonly childSessionId: SessionId
  readonly forkOffset: string
  readonly initialWrite: ProducerAppendResult
}

export interface SpawnAllInput {
  readonly parentSessionId: SessionId
  readonly toolCallId: string
  readonly tasks: ReadonlyArray<SpawnChildTask>
}

export interface SpawnAllResult {
  readonly parent: SessionHandle
  readonly children: ReadonlyArray<SpawnChildResult>
}

export interface PublishChildResultInput {
  readonly parentSessionId: SessionId
  readonly childSessionId: SessionId
  readonly resultId: string
  readonly result: unknown
}

export interface PublishChildResultResult {
  readonly child: SessionHandle
  readonly write: ProducerAppendResult
}

export type JoinChildResultResult =
  | {
    readonly _tag: "Pending"
    readonly turn: TurnHandle
  }
  | {
    readonly _tag: "Matched"
    readonly turn: TurnHandle
    readonly matched: TurnWaitMatchedEvent
    readonly childResult: SessionChildResultEvent
  }

export interface JoinChildResultInput {
  readonly parentSessionId: SessionId
  readonly turnId: TurnId
  readonly childSessionId: SessionId
  readonly resultId: string
  readonly waitId?: WaitId
}

export type ChildRaceLoserPolicy = "let_finish" | "cancel"

export interface RecordChildRaceWinnerInput {
  readonly parentSessionId: SessionId
  readonly raceId: string
  readonly winnerChildSessionId: SessionId
  readonly loserPolicy: ChildRaceLoserPolicy
}

export interface RecordChildRaceWinnerResult {
  readonly parent: SessionHandle
}

export type StoreRequirements = never

export class FluentStore extends Context.Tag("@firegrid/fluent-runtime/Store/FluentStore")<
  FluentStore,
  {
    readonly sessionUrl: (sessionId: SessionId) => string
    readonly turnUrl: (sessionId: SessionId, turnId: TurnId) => string
    readonly createSession: (
      input: CreateSessionInput,
    ) => Effect.Effect<SessionHandle, FluentRuntimeError, StoreRequirements>
    readonly appendSessionEvent: (
      input: AppendSessionEventInput,
    ) => Effect.Effect<SessionHandle, FluentRuntimeError, StoreRequirements>
    readonly appendSessionEventFenced: (
      input: AppendSessionEventFencedInput,
    ) => Effect.Effect<AppendSessionEventFencedResult, FluentRuntimeError, StoreRequirements>
    readonly appendStateChangeFenced: (
      input: AppendStateChangeFencedInput,
    ) => Effect.Effect<AppendStateChangeFencedResult, FluentRuntimeError, StoreRequirements>
    readonly collectSession: (
      sessionId: SessionId,
    ) => Effect.Effect<ReadonlyArray<SessionEvent>, FluentRuntimeError, StoreRequirements>
    readonly headSession: (
      sessionId: SessionId,
    ) => Effect.Effect<HeadResult, FluentRuntimeError, StoreRequirements>
    readonly forkSession: (
      input: ForkSessionInput,
    ) => Effect.Effect<ForkSessionResult, never, StoreRequirements>
    readonly spawnChild: (
      input: SpawnChildInput,
    ) => Effect.Effect<SpawnChildResult, FluentRuntimeError, StoreRequirements>
    readonly spawnAll: (
      input: SpawnAllInput,
    ) => Effect.Effect<SpawnAllResult, FluentRuntimeError, StoreRequirements>
    readonly publishChildResult: (
      input: PublishChildResultInput,
    ) => Effect.Effect<PublishChildResultResult, FluentRuntimeError, StoreRequirements>
    readonly joinChildResult: (
      input: JoinChildResultInput,
    ) => Effect.Effect<JoinChildResultResult, FluentRuntimeError, StoreRequirements>
    readonly recordChildRaceWinner: (
      input: RecordChildRaceWinnerInput,
    ) => Effect.Effect<RecordChildRaceWinnerResult, FluentRuntimeError, StoreRequirements>
    readonly startTurn: (
      input: StartTurnInput,
    ) => Effect.Effect<TurnHandle, FluentRuntimeError, StoreRequirements>
    readonly completeTurn: (
      input: CompleteTurnInput,
    ) => Effect.Effect<TurnHandle, FluentRuntimeError, StoreRequirements>
    readonly failTurn: (
      input: FailTurnInput,
    ) => Effect.Effect<TurnHandle, FluentRuntimeError, StoreRequirements>
    readonly scheduleTurnTimer: (
      input: ScheduleTurnTimerInput,
    ) => Effect.Effect<ScheduleTurnTimerResult, FluentRuntimeError, StoreRequirements>
    readonly fireTurnTimer: (
      input: FireTurnTimerInput,
    ) => Effect.Effect<FireTurnTimerResult, FluentRuntimeError, StoreRequirements>
    readonly durableSleep: (
      input: ScheduleTurnTimerInput,
    ) => Effect.Effect<TurnTimerWaitResult, FluentRuntimeError, StoreRequirements>
    readonly registerTurnWait: (
      input: RegisterTurnWaitInput,
    ) => Effect.Effect<RegisterTurnWaitResult, FluentRuntimeError, StoreRequirements>
    readonly matchTurnWait: (
      input: MatchTurnWaitInput,
    ) => Effect.Effect<MatchTurnWaitResult, FluentRuntimeError, StoreRequirements>
    readonly durableWait: (
      input: RegisterTurnWaitInput,
    ) => Effect.Effect<TurnWaitResult, FluentRuntimeError, StoreRequirements>
    readonly readTurn: (
      sessionId: SessionId,
      turnId: TurnId,
    ) => Effect.Effect<ReadTurnResult, FluentRuntimeError, StoreRequirements>
  }
>() {}

const encodeSegment = (segment: string): string => encodeURIComponent(segment)

const normalizeBaseUrl = (baseUrl: string): string =>
  baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl

const streamUrl = (
  config: StoreConfig,
  segments: ReadonlyArray<string>,
): string =>
  `${normalizeBaseUrl(config.durableStreamsBaseUrl)}/v1/stream/${
    encodeSegment(config.namespace)
  }/${segments.map(encodeSegment).join("/")}`

const endpoint = (url: string): Endpoint => ({ url })

const streamPathname = (url: string): string => new URL(url).pathname

const sessionStream = (url: string) =>
  DurableStream.define({
    endpoint: endpoint(url),
    schema: SessionEventSchema,
  })

const turnStream = (url: string) =>
  DurableStream.define({
    endpoint: endpoint(url),
    schema: TurnEventSchema,
  })

const toRuntimeError = (
  message: string,
) =>
  (cause: unknown): FluentRuntimeError =>
    new FluentRuntimeError({ message, cause })

const jsonBatch = <A>(event: A): string => JSON.stringify([event])

const timerProducerId = (
  kind: "schedule" | "fire",
  input: {
    readonly sessionId: SessionId
    readonly turnId: TurnId
    readonly timerId: TimerId
  },
): string =>
  [
    "fluent-runtime",
    "timer",
    kind,
    encodeSegment(input.sessionId),
    encodeSegment(input.turnId),
    encodeSegment(input.timerId),
  ].join("/")

const waitProducerId = (
  kind: "register" | "match",
  input: {
    readonly sessionId: SessionId
    readonly turnId: TurnId
    readonly waitId: WaitId
  },
): string =>
  [
    "fluent-runtime",
    "wait",
    kind,
    encodeSegment(input.sessionId),
    encodeSegment(input.turnId),
    encodeSegment(input.waitId),
  ].join("/")

const childSessionIdForSpawn = (
  parentSessionId: SessionId,
  toolCallId: string,
  slot: number,
): SessionId =>
  `${parentSessionId}/children/${toolCallId}/${slot}`

const childProducerId = (
  kind: "initial" | "result",
  input: {
    readonly childSessionId: SessionId
    readonly resultId?: string
  },
): string =>
  [
    "fluent-runtime",
    "child",
    kind,
    encodeSegment(input.childSessionId),
    ...(input.resultId === undefined ? [] : [encodeSegment(input.resultId)]),
  ].join("/")

const celEnvironment = new Environment({ unlistedVariablesAreDyn: true })

const evaluateWaitPredicate = (
  predicate: string,
  event: unknown,
  self: unknown,
): Effect.Effect<boolean, FluentRuntimeError> =>
  Effect.try({
    try: () => celEnvironment.evaluate(predicate, { event, self }) === true,
    catch: (cause) =>
      new FluentRuntimeError({
        message: "Failed to evaluate wait predicate",
        cause,
      }),
  })

const isAfterOffset = (
  matchedOffset: string,
  afterOffset: string,
): Effect.Effect<boolean, FluentRuntimeError> =>
  Effect.try({
    try: () => BigInt(matchedOffset) > BigInt(afterOffset),
    catch: (cause) =>
      new FluentRuntimeError({
        message: "Failed to compare wait offsets",
        cause,
      }),
  })

const findLastEvent = <A extends TurnEvent>(
  events: ReadonlyArray<TurnEvent>,
  predicate: (event: TurnEvent) => event is A,
): A | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event !== undefined && predicate(event)) return event
  }
  return undefined
}

const findIndexedSessionEvent = <A extends SessionEvent>(
  events: ReadonlyArray<SessionEvent>,
  predicate: (event: SessionEvent) => event is A,
): { readonly event: A; readonly offset: string } | undefined => {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event !== undefined && predicate(event)) {
      return { event, offset: String(index) }
    }
  }
  return undefined
}

const makeSessionHandle = (
  config: StoreConfig,
  sessionId: SessionId,
): SessionHandle => ({
  sessionId,
  eventsUrl: streamUrl(config, ["sessions", sessionId]),
})

const makeTurnHandle = (
  config: StoreConfig,
  sessionId: SessionId,
  turnId: TurnId,
): TurnHandle => ({
  sessionId,
  turnId,
  eventsUrl: streamUrl(config, ["sessions", sessionId, "turns", turnId]),
})

export const makeFluentStore = (
  config: StoreConfig,
  httpClient: HttpClient.HttpClient,
): Context.Tag.Service<typeof FluentStore> => {
  const provideHttp = <A, E>(
    effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  ): Effect.Effect<A, E> =>
    Effect.provideService(effect, HttpClient.HttpClient, httpClient)

  const createSession = (
    input: CreateSessionInput,
  ) =>
    Effect.gen(function* () {
      const handle = makeSessionHandle(config, input.sessionId)
      const stream = sessionStream(handle.eventsUrl)
      yield* stream.create({ contentType: "application/json" }).pipe(
        Effect.mapError(toRuntimeError("Failed to create session stream")),
      )
      yield* stream.append({
        type: "session.created",
        sessionId: input.sessionId,
        agent: input.agent,
      }).pipe(
        Effect.mapError(toRuntimeError("Failed to append session.created event")),
      )
      return handle
    }).pipe(
      Effect.withSpan("fluent_runtime.store.session.create", {
        attributes: {
          "firegrid.session.id": input.sessionId,
          "firegrid.agent": input.agent,
        },
      }),
    )

  const appendSessionEvent = (
    input: AppendSessionEventInput,
  ) =>
    Effect.gen(function* () {
      const handle = makeSessionHandle(config, input.sessionId)
      yield* sessionStream(handle.eventsUrl).append({
        type: "session.event_appended",
        sessionId: input.sessionId,
        name: input.name,
        payload: input.payload,
      }).pipe(
        Effect.mapError(toRuntimeError("Failed to append session event")),
      )
      return handle
    }).pipe(
      Effect.withSpan("fluent_runtime.store.session.append_event", {
        attributes: {
          "firegrid.session.id": input.sessionId,
          "firegrid.session.event.name": input.name,
        },
      }),
    )

  const appendSessionEventFenced = (
    input: AppendSessionEventFencedInput,
  ) =>
    Effect.gen(function* () {
      const handle = makeSessionHandle(config, input.sessionId)
      const event: SessionEvent = {
        type: "session.event_appended",
        sessionId: input.sessionId,
        name: input.name,
        payload: input.payload,
      }
      const write = yield* DurableStream.appendWithProducer({
        endpoint: endpoint(handle.eventsUrl),
        schema: SessionEventSchema,
        event,
        producerId: input.fence.producerId,
        producerEpoch: input.fence.epoch,
        producerSeq: input.fence.seq,
      }).pipe(
        Effect.mapError(toRuntimeError("Failed to append fenced session event")),
      )
      return { handle, write }
    }).pipe(
      Effect.withSpan("fluent_runtime.store.session.append_event_fenced", {
        attributes: {
          "firegrid.session.id": input.sessionId,
          "firegrid.session.event.name": input.name,
          "fluent_runtime.producer.id": input.fence.producerId,
          "fluent_runtime.producer.epoch": input.fence.epoch,
          "fluent_runtime.producer.seq": input.fence.seq,
        },
      }),
    )

  const appendStateChangeFenced = (
    input: AppendStateChangeFencedInput,
  ) =>
    Effect.gen(function* () {
      const handle = makeSessionHandle(config, input.sessionId)
      const write = yield* DurableStream.appendWithProducer({
        endpoint: endpoint(handle.eventsUrl),
        schema: SessionEventSchema,
        event: input.change,
        producerId: input.fence.producerId,
        producerEpoch: input.fence.epoch,
        producerSeq: input.fence.seq,
      }).pipe(
        Effect.mapError(toRuntimeError("Failed to append fenced state change")),
      )
      return { handle, write, change: input.change }
    }).pipe(
      Effect.withSpan("fluent_runtime.store.state_change.append_fenced", {
        attributes: {
          "firegrid.session.id": input.sessionId,
          "fluent_runtime.state_change.type": input.change.type,
          "fluent_runtime.state_change.key": input.change.key,
          "fluent_runtime.producer.id": input.fence.producerId,
          "fluent_runtime.producer.epoch": input.fence.epoch,
          "fluent_runtime.producer.seq": input.fence.seq,
        },
      }),
    )

  const collectSession = (sessionId: SessionId) =>
    sessionStream(makeSessionHandle(config, sessionId).eventsUrl).collect.pipe(
      Effect.mapError(toRuntimeError("Failed to collect session events")),
      Effect.withSpan("fluent_runtime.store.session.collect", {
        attributes: { "firegrid.session.id": sessionId },
      }),
    )

  const headSession = (sessionId: SessionId) =>
    sessionStream(makeSessionHandle(config, sessionId).eventsUrl).head.pipe(
      Effect.mapError(toRuntimeError("Failed to read session head")),
      Effect.withSpan("fluent_runtime.store.session.head", {
        attributes: { "firegrid.session.id": sessionId },
      }),
    )

  const startTurn = (
    input: StartTurnInput,
  ) =>
    Effect.gen(function* () {
      const handle = makeTurnHandle(config, input.sessionId, input.turnId)
      const stream = turnStream(handle.eventsUrl)
      yield* stream.create({ contentType: "application/json" }).pipe(
        Effect.mapError(toRuntimeError("Failed to create turn stream")),
      )
      yield* stream.append({
        type: "turn.started",
        sessionId: input.sessionId,
        turnId: input.turnId,
        prompt: input.prompt,
      }).pipe(
        Effect.mapError(toRuntimeError("Failed to append turn.started event")),
      )
      return handle
    }).pipe(
      Effect.withSpan("fluent_runtime.store.turn.start", {
        attributes: {
          "firegrid.session.id": input.sessionId,
          "firegrid.turn.id": input.turnId,
        },
      }),
    )

  const closeTurnWith = (
    handle: TurnHandle,
    event: TurnEvent,
    message: string,
  ) =>
    turnStream(handle.eventsUrl).close({
      body: jsonBatch(event),
      contentType: "application/json",
    }).pipe(
      Effect.as(handle),
      Effect.mapError(toRuntimeError(message)),
    )

  const appendTurnEventWithProducer = (
    turn: TurnHandle,
    event: TurnEvent,
    producerId: string,
    message: string,
  ) =>
    DurableStream.appendWithProducer({
      endpoint: endpoint(turn.eventsUrl),
      schema: TurnEventSchema,
      event,
      producerId,
      producerEpoch: 0,
      producerSeq: 0,
    }).pipe(
      Effect.mapError(toRuntimeError(message)),
    )

  const completeTurn = (
    input: CompleteTurnInput,
  ) => {
    const handle = makeTurnHandle(config, input.sessionId, input.turnId)
    return closeTurnWith(handle, {
      type: "turn.completed",
      sessionId: input.sessionId,
      turnId: input.turnId,
      result: input.result,
    }, "Failed to append-and-close turn.completed").pipe(
      Effect.withSpan("fluent_runtime.store.turn.complete", {
        attributes: {
          "firegrid.session.id": input.sessionId,
          "firegrid.turn.id": input.turnId,
          "fluent_runtime.close.atomic": true,
        },
      }),
    )
  }

  const failTurn = (
    input: FailTurnInput,
  ) => {
    const handle = makeTurnHandle(config, input.sessionId, input.turnId)
    return closeTurnWith(handle, {
      type: "turn.failed",
      sessionId: input.sessionId,
      turnId: input.turnId,
      message: input.message,
    }, "Failed to append-and-close turn.failed").pipe(
      Effect.withSpan("fluent_runtime.store.turn.fail", {
        attributes: {
          "firegrid.session.id": input.sessionId,
          "firegrid.turn.id": input.turnId,
          "fluent_runtime.close.atomic": true,
        },
      }),
    )
  }

  const scheduleTurnTimer = (
    input: ScheduleTurnTimerInput,
  ) =>
    Effect.gen(function* () {
      const turn = makeTurnHandle(config, input.sessionId, input.turnId)
      const write = yield* appendTurnEventWithProducer(
        turn,
        {
          type: "turn.timer_scheduled",
          sessionId: input.sessionId,
          turnId: input.turnId,
          timerId: input.timerId,
          fireAtEpochMs: input.fireAtEpochMs,
        },
        timerProducerId("schedule", input),
        "Failed to append fenced turn.timer_scheduled event",
      )
      return { turn, write }
    }).pipe(
      Effect.withSpan("fluent_runtime.store.turn.timer.schedule", {
        attributes: {
          "firegrid.session.id": input.sessionId,
          "firegrid.turn.id": input.turnId,
          "fluent_runtime.timer.id": input.timerId,
          "fluent_runtime.timer.fire_at_epoch_ms": input.fireAtEpochMs,
        },
      }),
    )

  const fireTurnTimer = (
    input: FireTurnTimerInput,
  ) =>
    Effect.gen(function* () {
      const turn = makeTurnHandle(config, input.sessionId, input.turnId)
      const write = yield* appendTurnEventWithProducer(
        turn,
        {
          type: "turn.timer_fired",
          sessionId: input.sessionId,
          turnId: input.turnId,
          timerId: input.timerId,
          firedAtEpochMs: input.firedAtEpochMs,
        },
        timerProducerId("fire", input),
        "Failed to append fenced turn.timer_fired event",
      )
      return { turn, write }
    }).pipe(
      Effect.withSpan("fluent_runtime.store.turn.timer.fire", {
        attributes: {
          "firegrid.session.id": input.sessionId,
          "firegrid.turn.id": input.turnId,
          "fluent_runtime.timer.id": input.timerId,
          "fluent_runtime.timer.fired_at_epoch_ms": input.firedAtEpochMs,
        },
      }),
    )

  const timerStatusFromEvents = (
    turn: TurnHandle,
    timerId: TimerId,
    events: ReadonlyArray<TurnEvent>,
  ): Effect.Effect<TurnTimerWaitResult, FluentRuntimeError> =>
    Effect.gen(function* () {
      const scheduled = findLastEvent(
        events,
        (event): event is TurnTimerScheduledEvent =>
          event.type === "turn.timer_scheduled" && event.timerId === timerId,
      )
      if (scheduled === undefined) {
        return yield* new FluentRuntimeError({
          message: `Missing durable timer schedule for ${timerId}`,
        })
      }
      const fired = findLastEvent(
        events,
        (event): event is TurnTimerFiredEvent =>
          event.type === "turn.timer_fired" && event.timerId === timerId,
      )
      return fired === undefined
        ? { _tag: "Pending", turn, scheduled }
        : { _tag: "Fired", turn, scheduled, fired }
    })

  const durableSleep = (
    input: ScheduleTurnTimerInput,
  ) =>
    Effect.gen(function* () {
      yield* scheduleTurnTimer(input)
      const read = yield* readTurn(input.sessionId, input.turnId)
      return yield* timerStatusFromEvents(read.turn, input.timerId, read.events)
    }).pipe(
      Effect.withSpan("fluent_runtime.store.turn.durable_sleep", {
        attributes: {
          "firegrid.session.id": input.sessionId,
          "firegrid.turn.id": input.turnId,
          "fluent_runtime.timer.id": input.timerId,
        },
      }),
    )

  const registerTurnWait = (
    input: RegisterTurnWaitInput,
  ) =>
    Effect.gen(function* () {
      const turn = makeTurnHandle(config, input.sessionId, input.turnId)
      const write = yield* appendTurnEventWithProducer(
        turn,
        {
          type: "turn.wait_registered",
          sessionId: input.sessionId,
          turnId: input.turnId,
          waitId: input.waitId,
          predicate: input.predicate,
          afterOffset: input.afterOffset,
          ...(input.self === undefined ? {} : { self: input.self }),
        },
        waitProducerId("register", input),
        "Failed to append fenced turn.wait_registered event",
      )
      return { turn, write }
    }).pipe(
      Effect.withSpan("fluent_runtime.store.turn.wait.register", {
        attributes: {
          "firegrid.session.id": input.sessionId,
          "firegrid.turn.id": input.turnId,
          "fluent_runtime.wait.id": input.waitId,
          "fluent_runtime.wait.after_offset": input.afterOffset,
        },
      }),
    )

  const matchTurnWait = (
    input: MatchTurnWaitInput,
  ) =>
    Effect.gen(function* () {
      const turn = makeTurnHandle(config, input.sessionId, input.turnId)
      const read = yield* readTurn(input.sessionId, input.turnId)
      const registered = findLastEvent(
        read.events,
        (event): event is TurnWaitRegisteredEvent =>
          event.type === "turn.wait_registered" && event.waitId === input.waitId,
      )
      if (registered === undefined) {
        return yield* new FluentRuntimeError({
          message: `Missing durable wait registration for ${input.waitId}`,
        })
      }
      const candidateIsAfterRegistration = yield* isAfterOffset(
        input.matchedOffset,
        registered.afterOffset,
      )
      if (!candidateIsAfterRegistration) {
        return { _tag: "NotMatched" as const, turn, registered }
      }
      const matched = yield* evaluateWaitPredicate(
        registered.predicate,
        input.event,
        registered.self ?? {},
      )
      if (!matched) return { _tag: "NotMatched" as const, turn, registered }
      const write = yield* appendTurnEventWithProducer(
        turn,
        {
          type: "turn.wait_matched",
          sessionId: input.sessionId,
          turnId: input.turnId,
          waitId: input.waitId,
          matchedOffset: input.matchedOffset,
          event: input.event,
        },
        waitProducerId("match", input),
        "Failed to append fenced turn.wait_matched event",
      )
      return { _tag: "Matched" as const, turn, write }
    }).pipe(
      Effect.withSpan("fluent_runtime.store.turn.wait.match", {
        attributes: {
          "firegrid.session.id": input.sessionId,
          "firegrid.turn.id": input.turnId,
          "fluent_runtime.wait.id": input.waitId,
          "fluent_runtime.wait.matched_offset": input.matchedOffset,
        },
      }),
    )

  const waitStatusFromEvents = (
    turn: TurnHandle,
    waitId: WaitId,
    events: ReadonlyArray<TurnEvent>,
  ): Effect.Effect<TurnWaitResult, FluentRuntimeError> =>
    Effect.gen(function* () {
      const registered = findLastEvent(
        events,
        (event): event is TurnWaitRegisteredEvent =>
          event.type === "turn.wait_registered" && event.waitId === waitId,
      )
      if (registered === undefined) {
        return yield* new FluentRuntimeError({
          message: `Missing durable wait registration for ${waitId}`,
        })
      }
      const matched = findLastEvent(
        events,
        (event): event is TurnWaitMatchedEvent =>
          event.type === "turn.wait_matched" && event.waitId === waitId,
      )
      return matched === undefined
        ? { _tag: "Pending", turn, registered }
        : { _tag: "Matched", turn, registered, matched }
    })

  const durableWait = (
    input: RegisterTurnWaitInput,
  ) =>
    Effect.gen(function* () {
      yield* registerTurnWait(input)
      const read = yield* readTurn(input.sessionId, input.turnId)
      return yield* waitStatusFromEvents(read.turn, input.waitId, read.events)
    }).pipe(
      Effect.withSpan("fluent_runtime.store.turn.durable_wait", {
        attributes: {
          "firegrid.session.id": input.sessionId,
          "firegrid.turn.id": input.turnId,
          "fluent_runtime.wait.id": input.waitId,
        },
      }),
    )

  const readTurn = (sessionId: SessionId, turnId: TurnId) =>
    Effect.gen(function* () {
      const handle = makeTurnHandle(config, sessionId, turnId)
      const stream = turnStream(handle.eventsUrl)
      const events = yield* stream.collect.pipe(
        Effect.mapError(toRuntimeError("Failed to collect turn events")),
      )
      const head = yield* stream.head.pipe(
        Effect.mapError(toRuntimeError("Failed to read turn head")),
      )
      return {
        turn: handle,
        events,
        head,
        streamClosed: head.streamClosed,
      }
    }).pipe(
      Effect.withSpan("fluent_runtime.store.turn.read", {
        attributes: {
          "firegrid.session.id": sessionId,
          "firegrid.turn.id": turnId,
        },
      }),
    )

  const forkSession = (
    input: ForkSessionInput,
  ) => {
    const parent = makeSessionHandle(config, input.parentSessionId)
    const child = makeSessionHandle(config, input.childSessionId)
    return Effect.gen(function* () {
      yield* sessionStream(child.eventsUrl).create({
        contentType: "application/json",
        headers: {
          "Stream-Forked-From": streamPathname(parent.eventsUrl),
          "Stream-Fork-Offset": input.forkOffset,
        },
      })
      yield* sessionStream(parent.eventsUrl).append({
        type: "session.forked",
        parentSessionId: input.parentSessionId,
        childSessionId: input.childSessionId,
        forkOffset: input.forkOffset,
      })
      return { _tag: "Forked", parent, child } satisfies ForkSessionResult
    }).pipe(
      Effect.catchAll((cause) =>
        Effect.succeed<ForkSessionResult>({
          _tag: "Unsupported",
          parent,
          child,
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
      ),
      Effect.withSpan("fluent_runtime.store.session.fork_probe", {
        attributes: {
          "firegrid.session.parent_id": input.parentSessionId,
          "firegrid.session.child_id": input.childSessionId,
          "firegrid.session.fork_offset": input.forkOffset,
        },
      }),
    )
  }

  const spawnChild = (
    input: SpawnChildInput,
  ) =>
    Effect.gen(function* () {
      const head = yield* headSession(input.parentSessionId)
      const childSessionId = childSessionIdForSpawn(
        input.parentSessionId,
        input.toolCallId,
        input.slot,
      )
      const fork = yield* forkSession({
        parentSessionId: input.parentSessionId,
        childSessionId,
        forkOffset: head.offset,
      })
      if (fork._tag === "Unsupported") {
        return yield* new FluentRuntimeError({
          message: `Failed to fork child session ${childSessionId}: ${fork.reason}`,
        })
      }
      yield* sessionStream(fork.parent.eventsUrl).append({
        type: "session.child_spawned",
        parentSessionId: input.parentSessionId,
        childSessionId,
        toolCallId: input.toolCallId,
        slot: input.slot,
        forkOffset: head.offset,
        prompt: input.prompt,
      }).pipe(
        Effect.mapError(toRuntimeError("Failed to append session.child_spawned event")),
      )
      const initialWrite = yield* DurableStream.appendWithProducer({
        endpoint: endpoint(fork.child.eventsUrl),
        schema: SessionEventSchema,
        event: {
          type: "session.event_appended",
          sessionId: childSessionId,
          name: "child.prompt",
          payload: { prompt: input.prompt },
        },
        producerId: childProducerId("initial", { childSessionId }),
        producerEpoch: 0,
        producerSeq: 0,
      }).pipe(
        Effect.mapError(toRuntimeError("Failed to append child initial prompt")),
      )
      return {
        parent: fork.parent,
        child: fork.child,
        childSessionId,
        forkOffset: head.offset,
        initialWrite,
      }
    }).pipe(
      Effect.withSpan("fluent_runtime.store.child.spawn", {
        attributes: {
          "firegrid.session.parent_id": input.parentSessionId,
          "fluent_runtime.tool_call.id": input.toolCallId,
          "fluent_runtime.spawn.slot": input.slot,
        },
      }),
    )

  const spawnAll = (
    input: SpawnAllInput,
  ) =>
    Effect.gen(function* () {
      const children = yield* Effect.forEach(
        input.tasks,
        (task, slot) =>
          spawnChild({
            parentSessionId: input.parentSessionId,
            toolCallId: input.toolCallId,
            slot,
            prompt: task.prompt,
          }),
        { concurrency: "unbounded" },
      )
      return {
        parent: makeSessionHandle(config, input.parentSessionId),
        children,
      }
    }).pipe(
      Effect.withSpan("fluent_runtime.store.child.spawn_all", {
        attributes: {
          "firegrid.session.parent_id": input.parentSessionId,
          "fluent_runtime.tool_call.id": input.toolCallId,
          "fluent_runtime.spawn.count": input.tasks.length,
        },
      }),
    )

  const publishChildResult = (
    input: PublishChildResultInput,
  ) =>
    Effect.gen(function* () {
      const child = makeSessionHandle(config, input.childSessionId)
      const write = yield* DurableStream.appendWithProducer({
        endpoint: endpoint(child.eventsUrl),
        schema: SessionEventSchema,
        event: {
          type: "session.child_result",
          parentSessionId: input.parentSessionId,
          childSessionId: input.childSessionId,
          resultId: input.resultId,
          result: input.result,
        },
        producerId: childProducerId("result", input),
        producerEpoch: 0,
        producerSeq: 0,
      }).pipe(
        Effect.mapError(toRuntimeError("Failed to append session.child_result event")),
      )
      return { child, write }
    }).pipe(
      Effect.withSpan("fluent_runtime.store.child.result", {
        attributes: {
          "firegrid.session.parent_id": input.parentSessionId,
          "firegrid.session.child_id": input.childSessionId,
          "fluent_runtime.result.id": input.resultId,
        },
      }),
    )

  const childResultWaitId = (
    input: JoinChildResultInput,
  ): WaitId =>
    input.waitId ?? `child-result:${input.childSessionId}:${input.resultId}`

  const joinChildResult = (
    input: JoinChildResultInput,
  ) =>
    Effect.gen(function* () {
      const waitId = childResultWaitId(input)
      yield* registerTurnWait({
        sessionId: input.parentSessionId,
        turnId: input.turnId,
        waitId,
        predicate:
          "event.type == self.type && event.childSessionId == self.childSessionId && event.resultId == self.resultId",
        afterOffset: "-1",
        self: {
          type: "session.child_result",
          childSessionId: input.childSessionId,
          resultId: input.resultId,
        },
      })
      const childEvents = yield* collectSession(input.childSessionId)
      const found = findIndexedSessionEvent(
        childEvents,
        (event): event is SessionChildResultEvent =>
          event.type === "session.child_result" &&
          "childSessionId" in event &&
          "resultId" in event &&
          event.childSessionId === input.childSessionId &&
          event.resultId === input.resultId,
      )
      if (found === undefined) {
        const turn = makeTurnHandle(config, input.parentSessionId, input.turnId)
        return { _tag: "Pending" as const, turn }
      }
      yield* matchTurnWait({
        sessionId: input.parentSessionId,
        turnId: input.turnId,
        waitId,
        matchedOffset: found.offset,
        event: found.event,
      })
      const wait = yield* durableWait({
        sessionId: input.parentSessionId,
        turnId: input.turnId,
        waitId,
        predicate:
          "event.type == self.type && event.childSessionId == self.childSessionId && event.resultId == self.resultId",
        afterOffset: "-1",
        self: {
          type: "session.child_result",
          childSessionId: input.childSessionId,
          resultId: input.resultId,
        },
      })
      return wait._tag === "Matched"
        ? {
          _tag: "Matched" as const,
          turn: wait.turn,
          matched: wait.matched,
          childResult: found.event,
        }
        : { _tag: "Pending" as const, turn: wait.turn }
    }).pipe(
      Effect.withSpan("fluent_runtime.store.child.join", {
        attributes: {
          "firegrid.session.parent_id": input.parentSessionId,
          "firegrid.session.child_id": input.childSessionId,
          "fluent_runtime.result.id": input.resultId,
        },
      }),
    )

  const recordChildRaceWinner = (
    input: RecordChildRaceWinnerInput,
  ) =>
    Effect.gen(function* () {
      const parent = makeSessionHandle(config, input.parentSessionId)
      yield* sessionStream(parent.eventsUrl).append({
        type: "session.child_race_winner",
        parentSessionId: input.parentSessionId,
        raceId: input.raceId,
        winnerChildSessionId: input.winnerChildSessionId,
        loserPolicy: input.loserPolicy,
      }).pipe(
        Effect.mapError(toRuntimeError("Failed to append session.child_race_winner event")),
      )
      return { parent }
    }).pipe(
      Effect.withSpan("fluent_runtime.store.child.race_winner", {
        attributes: {
          "firegrid.session.parent_id": input.parentSessionId,
          "fluent_runtime.race.id": input.raceId,
          "firegrid.session.child_id": input.winnerChildSessionId,
          "fluent_runtime.race.loser_policy": input.loserPolicy,
        },
      }),
    )

  return {
    sessionUrl: (sessionId) => makeSessionHandle(config, sessionId).eventsUrl,
    turnUrl: (sessionId, turnId) => makeTurnHandle(config, sessionId, turnId).eventsUrl,
    createSession: (input) => provideHttp(createSession(input)),
    appendSessionEvent: (input) => provideHttp(appendSessionEvent(input)),
    appendSessionEventFenced: (input) => provideHttp(appendSessionEventFenced(input)),
    appendStateChangeFenced: (input) => provideHttp(appendStateChangeFenced(input)),
    collectSession: (sessionId) => provideHttp(collectSession(sessionId)),
    headSession: (sessionId) => provideHttp(headSession(sessionId)),
    forkSession: (input) => provideHttp(forkSession(input)),
    spawnChild: (input) => provideHttp(spawnChild(input)),
    spawnAll: (input) => provideHttp(spawnAll(input)),
    publishChildResult: (input) => provideHttp(publishChildResult(input)),
    joinChildResult: (input) => provideHttp(joinChildResult(input)),
    recordChildRaceWinner: (input) => provideHttp(recordChildRaceWinner(input)),
    startTurn: (input) => provideHttp(startTurn(input)),
    completeTurn: (input) => provideHttp(completeTurn(input)),
    failTurn: (input) => provideHttp(failTurn(input)),
    scheduleTurnTimer: (input) => provideHttp(scheduleTurnTimer(input)),
    fireTurnTimer: (input) => provideHttp(fireTurnTimer(input)),
    durableSleep: (input) => provideHttp(durableSleep(input)),
    registerTurnWait: (input) => provideHttp(registerTurnWait(input)),
    matchTurnWait: (input) => provideHttp(matchTurnWait(input)),
    durableWait: (input) => provideHttp(durableWait(input)),
    readTurn: (sessionId, turnId) => provideHttp(readTurn(sessionId, turnId)),
  }
}

export const FluentStoreLive = (
  config: StoreConfig,
): Layer.Layer<FluentStore, never, HttpClient.HttpClient> =>
  Layer.effect(
    FluentStore,
    Effect.map(
      HttpClient.HttpClient,
      (httpClient) => makeFluentStore(config, httpClient),
    ),
  )
