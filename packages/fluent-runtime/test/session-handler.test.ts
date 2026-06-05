import { Effect, Layer, Stream, type Context } from "effect"
import { describe, expect, it } from "vitest"
import type {
  AgentAdapter,
  AgentConnection,
  ClientIntent,
  SpawnOptions,
  StreamEnvelope,
} from "../src/Adapter.ts"
import type { SessionEvent } from "../src/Domain.ts"
import {
  FluentSessionDriverLive,
  FluentStore,
  FluentWorkerClaimHeld,
  FluentWorkerFenced,
  FluentWorkerSubscriptions,
  handleFluentWorkerWake,
  type AppendSessionEventFencedInput,
  type FluentSessionDriveHarness,
  type FluentWorkerSessionDriver,
  type FluentWorkerAck,
  type FluentWorkerLease,
  type FluentWorkerLeaseStream,
  type FluentWorkerWake,
  type WorkerId,
} from "../src/index.ts"

interface FakeSubscriptionState {
  readonly order: Array<string>
  readonly leaseStreams: ReadonlyArray<FluentWorkerLeaseStream>
  readonly acks: Array<ReadonlyArray<FluentWorkerAck>>
  claimedBy: WorkerId | undefined
}

interface FakeStoreState {
  readonly order: Array<string>
  readonly events: ReadonlyArray<SessionEvent>
  readonly appended: Array<AppendSessionEventFencedInput>
}

interface FakeAdapterState {
  readonly spawnCalls: Array<SpawnOptions>
  readonly preparedHistory: Array<ReadonlyArray<StreamEnvelope>>
  readonly sent: Array<object>
}

const wake: FluentWorkerWake = {
  subscriptionId: "fluent-session-handler-wakes",
  sessionId: "session-handler-1",
  wakeId: "wake-1",
}

const leaseStreams: ReadonlyArray<FluentWorkerLeaseStream> = [
  {
    path: "/v1/stream/fluent/sessions/session-handler-1",
    ackedOffset: "3",
    tailOffset: "8",
  },
]

const makeSubscriptionState = (
  order: Array<string> = [],
): FakeSubscriptionState => ({
  order,
  leaseStreams,
  acks: [],
  claimedBy: undefined,
})

const makeStoreState = (
  events: ReadonlyArray<SessionEvent> = [],
  order: Array<string> = [],
): FakeStoreState => ({
  order,
  events,
  appended: [],
})

const makeLease = (
  state: FakeSubscriptionState,
  subscriptionId: string,
  workerId: WorkerId,
): FluentWorkerLease => ({
  subscriptionId,
  workerId,
  token: `token-${workerId}`,
  wakeId: "wake-1",
  generation: 7,
  leaseTtlMs: 30_000,
  streams: state.leaseStreams,
})

const makeSubscriptionsLayer = (
  state: FakeSubscriptionState,
) =>
  Layer.succeed(FluentWorkerSubscriptions, {
    consumeWakeStream: () => Stream.make(wake),
    claim: (subscriptionId, workerId) =>
      Effect.gen(function* () {
        state.order.push(`claim:${workerId}`)
        if (state.claimedBy !== undefined && state.claimedBy !== workerId) {
          return yield* new FluentWorkerClaimHeld({ holder: state.claimedBy })
        }
        state.claimedBy = workerId
        return makeLease(state, subscriptionId, workerId)
      }),
    ack: (lease, acks) =>
      Effect.gen(function* () {
        if (lease.generation !== 7) {
          return yield* new FluentWorkerFenced({ generation: 7 })
        }
        state.order.push("ack")
        state.acks.push(acks)
        state.claimedBy = undefined
        return { nextWake: false }
      }),
    release: (lease) =>
      Effect.sync(() => {
        state.order.push("release")
        if (state.claimedBy === lease.workerId) {
          state.claimedBy = undefined
        }
      }),
  })

const unsupported = <A>(): Effect.Effect<A> =>
  Effect.dieMessage("unused fake FluentStore method")

const makeStore = (
  state: FakeStoreState,
): Context.Tag.Service<typeof FluentStore> =>
  ({
    sessionUrl: (sessionId: string) => `/sessions/${sessionId}`,
    turnUrl: (sessionId: string, turnId: string) => `/sessions/${sessionId}/turns/${turnId}`,
    createSession: () => unsupported(),
    appendSessionEvent: () => unsupported(),
    appendSessionEventFenced: (input: AppendSessionEventFencedInput) =>
      Effect.sync(() => {
        state.order.push(`append:${input.name}`)
        state.appended.push(input)
        return {
          handle: {
            sessionId: input.sessionId,
            eventsUrl: `/sessions/${input.sessionId}`,
          },
          write: {
            _tag: "Appended" as const,
            offset: String(state.appended.length - 1),
          },
        }
      }),
    appendStateChangeFenced: () => unsupported(),
    collectSession: () =>
      Effect.sync(() => {
        state.order.push("collect")
        return state.events
      }),
    headSession: () => unsupported(),
    forkSession: () => unsupported(),
    spawnChild: () => unsupported(),
    spawnAll: () => unsupported(),
    publishChildResult: () => unsupported(),
    joinChildResult: () => unsupported(),
    recordChildRaceWinner: () => unsupported(),
    startTurn: () => unsupported(),
    completeTurn: () => unsupported(),
    failTurn: () => unsupported(),
    scheduleTurnTimer: () => unsupported(),
    fireTurnTimer: () => unsupported(),
    durableSleep: () => unsupported(),
    registerTurnWait: () => unsupported(),
    matchTurnWait: () => unsupported(),
    durableWait: () => unsupported(),
    readTurn: () => unsupported(),
  }) as unknown as Context.Tag.Service<typeof FluentStore>

const makeFakeAdapter = (
  state: FakeAdapterState,
  initialAgentMessage?: object,
): AgentAdapter => ({
  agentType: "codex",
  spawn: (spawnOptions) => {
    state.spawnCalls.push(spawnOptions)
    const connection: AgentConnection = {
      onMessage: (handler) => {
        if (initialAgentMessage !== undefined) {
          handler(initialAgentMessage)
        }
      },
      send: (raw) => {
        state.sent.push(raw)
      },
      kill: () => {},
      on: () => {},
    }
    return Promise.resolve(connection)
  },
  parseDirection: () => ({ type: "notification" }),
  isTurnComplete: (raw) => (raw as { readonly type?: unknown }).type === "turn_complete",
  translateClientIntent: (intent: ClientIntent) => ({ native: intent }),
  prepareResume: (history) => {
    state.preparedHistory.push(history)
    return Promise.resolve(history.length === 0 ? {} : { resumeId: "native-thread-1" })
  },
})

const envelopeEvent = (
  envelope: StreamEnvelope,
): SessionEvent => ({
  type: "session.event_appended",
  sessionId: wake.sessionId,
  name: "adapter.envelope",
  payload: envelope,
})

const runWith = <A, E>(
  subscriptionState: FakeSubscriptionState,
  storeState: FakeStoreState,
  adapterState: FakeAdapterState,
  effect: Effect.Effect<A, E, FluentWorkerSubscriptions | FluentWorkerSessionDriver>,
  options: {
    readonly initialAgentMessage?: object
    readonly driveHarness?: FluentSessionDriveHarness
  } = {},
): Promise<A> => {
  const adapter = makeFakeAdapter(adapterState, options.initialAgentMessage)
  const storeLayer = Layer.succeed(FluentStore, makeStore(storeState))
  const driverLayer = FluentSessionDriverLive({
    adapter,
    spawnOptions: { cwd: "/workspace" },
    ...(options.driveHarness === undefined ? {} : { driveHarness: options.driveHarness }),
  }).pipe(Layer.provide(storeLayer))

  return Effect.runPromise(
    effect.pipe(
      Effect.provide(Layer.merge(makeSubscriptionsLayer(subscriptionState), driverLayer)),
    ),
  )
}

describe("@firegrid/fluent-runtime SessionHandler", () => {
  it("fluent-session-handler.feature claimed wake materializes journal and provides writer wake and adapter services", async () => {
    const subscriptionState = makeSubscriptionState()
    const storeState = makeStoreState([
      envelopeEvent({ direction: "user", raw: { type: "user_message", text: "resume me" } }),
    ])
    const adapterState: FakeAdapterState = { spawnCalls: [], preparedHistory: [], sent: [] }
    const seen: Array<object> = []
    const driveHarness: FluentSessionDriveHarness = (input) =>
      Effect.gen(function* () {
        seen.push({
          history: input.services.journal.history.length,
          wakeId: input.services.wake.wake.wakeId,
          workerId: input.services.wake.lease.workerId,
          adapterType: input.services.adapter.adapter.agentType,
          cwd: input.services.adapter.spawnOptions.cwd,
        })
        yield* input.services.fencedWriter.append("test.services_seen", { ok: true })
        return { _tag: "Completed" as const, result: { ok: true } }
      })

    const result = await runWith(
      subscriptionState,
      storeState,
      adapterState,
      handleFluentWorkerWake(wake, "worker-1"),
      { driveHarness },
    )

    expect(result._tag).toBe("Completed")
    expect(seen).toEqual([{
      history: 1,
      wakeId: "wake-1",
      workerId: "worker-1",
      adapterType: "codex",
      cwd: "/workspace",
    }])
    expect(storeState.order).toEqual([
      "collect",
      "append:test.services_seen",
      "append:handler.completed",
    ])
    expect(subscriptionState.order).toEqual(["claim:worker-1", "ack", "release"])
    expect(storeState.appended.at(-1)?.fence).toEqual({
      producerId: "fluent-runtime/session-handler/session-handler-1/wake-1/worker-1",
      epoch: 7,
      seq: 1,
    })
  })

  it("fluent-session-handler.feature parking records durable suspension before returning without acking", async () => {
    const subscriptionState = makeSubscriptionState()
    const storeState = makeStoreState([
      envelopeEvent({ direction: "user", raw: { type: "user_message", text: "pending" } }),
    ])
    const adapterState: FakeAdapterState = { spawnCalls: [], preparedHistory: [], sent: [] }

    const result = await runWith(
      subscriptionState,
      storeState,
      adapterState,
      handleFluentWorkerWake(wake, "worker-1"),
      {
        initialAgentMessage: {
          type: "firegrid.park",
          waitId: "approval-1",
          predicate: "event.kind == 'approval'",
          afterOffset: "8",
          reason: "waiting for approval",
        },
      },
    )

    expect(result._tag).toBe("Suspended")
    expect(adapterState.preparedHistory[0]).toEqual([
      { direction: "user", raw: { type: "user_message", text: "pending" } },
    ])
    expect(adapterState.spawnCalls[0]?.resume).toBe("native-thread-1")
    expect(storeState.order.at(-1)).toBe("append:handler.suspended")
    expect(subscriptionState.order).toEqual(["claim:worker-1", "release"])
    expect(subscriptionState.acks).toEqual([])
    expect(storeState.appended.at(-1)?.payload).toEqual({
      wakeId: "wake-1",
      suspension: {
        waitId: "approval-1",
        predicate: "event.kind == 'approval'",
        afterOffset: "8",
        reason: "waiting for approval",
      },
    })
  })

  it("fluent-session-handler.feature driveHarness uses the adapter contract and records completion before worker ack", async () => {
    const order: Array<string> = []
    const subscriptionState = makeSubscriptionState(order)
    const storeState = makeStoreState([], order)
    const adapterState: FakeAdapterState = { spawnCalls: [], preparedHistory: [], sent: [] }

    const result = await runWith(
      subscriptionState,
      storeState,
      adapterState,
      handleFluentWorkerWake(wake, "worker-1"),
      { initialAgentMessage: { type: "turn_complete", result: "done" } },
    )

    expect(result._tag).toBe("Completed")
    expect(adapterState.spawnCalls).toEqual([{ cwd: "/workspace" }])
    expect(adapterState.preparedHistory).toEqual([])
    expect(order).toEqual([
      "claim:worker-1",
      "collect",
      "append:adapter.envelope",
      "append:adapter.envelope",
      "append:handler.completed",
      "ack",
      "release",
    ])
    expect(storeState.appended.at(-1)?.payload).toEqual({
      wakeId: "wake-1",
      result: { type: "turn_complete", result: "done" },
    })
  })
})
