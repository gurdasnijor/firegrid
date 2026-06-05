import { Effect, Layer, Stream } from "effect"
import { describe, expect, it } from "vitest"
import {
  FluentWorkerClaimHeld,
  FluentWorkerFenced,
  FluentWorkerRuntimeError,
  FluentWorkerSessionDriver,
  FluentWorkerSubscriptions,
  handleFluentWorkerWake,
  type FluentWorkerAck,
  type FluentWorkerDriveResult,
  type FluentWorkerLease,
  type FluentWorkerLeaseStream,
  type FluentWorkerMaterializedSession,
  type FluentWorkerWake,
  type WorkerId,
} from "../src/index.ts"

type WorkerReqs = FluentWorkerSubscriptions | FluentWorkerSessionDriver

interface FakeSubscriptionState {
  readonly claimFailures: Map<WorkerId, WorkerId>
  readonly leaseStreams: ReadonlyArray<FluentWorkerLeaseStream>
  readonly claims: Array<WorkerId>
  readonly acks: Array<ReadonlyArray<FluentWorkerAck>>
  readonly releases: Array<FluentWorkerLease>
  readonly wake: FluentWorkerWake
  claimedBy: WorkerId | undefined
  currentGeneration: number
  leaseGeneration: number
  deliveryAdvanced: boolean
  nextWake: boolean
}

interface FakeDriverState {
  readonly events: ReadonlyArray<unknown>
  readonly handledBy: Array<WorkerId>
  readonly handledEvents: Array<ReadonlyArray<unknown>>
  readonly replayedResults: Array<unknown>
  driveResult: FluentWorkerDriveResult
  sideEffectExecutions: number
}

const wake: FluentWorkerWake = {
  subscriptionId: "fluent-session-wakes",
  sessionId: "session-1",
  wakeId: "wake-1",
}

const makeSubscriptionState = (
  overrides: Partial<FakeSubscriptionState> = {},
): FakeSubscriptionState => ({
  claimFailures: new Map(),
  leaseStreams: [
    {
      path: "/v1/stream/fluent/sessions/session-1",
      ackedOffset: "10",
      tailOffset: "15",
    },
  ],
  claims: [],
  acks: [],
  releases: [],
  wake,
  claimedBy: undefined,
  currentGeneration: 1,
  leaseGeneration: 1,
  deliveryAdvanced: false,
  nextWake: false,
  ...overrides,
})

const makeDriverState = (
  overrides: Partial<FakeDriverState> = {},
): FakeDriverState => ({
  events: [],
  handledBy: [],
  handledEvents: [],
  replayedResults: [],
  driveResult: { _tag: "Completed" },
  sideEffectExecutions: 0,
  ...overrides,
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
  generation: state.leaseGeneration,
  leaseTtlMs: 30_000,
  streams: state.leaseStreams,
})

const makeSubscriptionsLayer = (
  state: FakeSubscriptionState,
) =>
  Layer.succeed(FluentWorkerSubscriptions, {
    consumeWakeStream: () => Stream.make(state.wake),
    claim: (subscriptionId, workerId) =>
      Effect.gen(function* () {
        state.claims.push(workerId)
        const holder = state.claimFailures.get(workerId)
        if (holder !== undefined) {
          return yield* new FluentWorkerClaimHeld({ holder })
        }
        if (state.claimedBy !== undefined && state.claimedBy !== workerId) {
          return yield* new FluentWorkerClaimHeld({ holder: state.claimedBy })
        }
        state.claimedBy = workerId
        return makeLease(state, subscriptionId, workerId)
      }),
    ack: (lease, acks) =>
      Effect.gen(function* () {
        if (lease.generation !== state.currentGeneration) {
          return yield* new FluentWorkerFenced({ generation: state.currentGeneration })
        }
        state.acks.push(acks)
        state.deliveryAdvanced = true
        state.claimedBy = undefined
        return { nextWake: state.nextWake }
      }),
    release: (lease) =>
      Effect.sync(() => {
        state.releases.push(lease)
        if (state.claimedBy === lease.workerId) {
          state.claimedBy = undefined
        }
      }),
  })

const makeDriverLayer = (
  state: FakeDriverState,
) =>
  Layer.succeed(FluentWorkerSessionDriver, {
    materialize: (observedWake) =>
      Effect.succeed({
        sessionId: observedWake.sessionId,
        replaySource: "journal",
        events: state.events,
      } satisfies FluentWorkerMaterializedSession),
    handleSession: (_observedWake, lease, materialized) =>
      Effect.sync(() => {
        state.handledBy.push(lease.workerId)
        state.handledEvents.push(materialized.events)
        const replayed = materialized.events.find((event) =>
          typeof event === "object" && event !== null && "journaledResult" in event,
        )
        if (replayed === undefined) {
          state.sideEffectExecutions += 1
        } else {
          state.replayedResults.push(replayed)
        }
        return state.driveResult
      }),
  })

const runWith = <A, E>(
  subscriptionState: FakeSubscriptionState,
  driverState: FakeDriverState,
  effect: Effect.Effect<A, E, WorkerReqs>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.merge(
          makeSubscriptionsLayer(subscriptionState),
          makeDriverLayer(driverState),
        ),
      ),
    ),
  )

describe("@firegrid/fluent-runtime Worker", () => {
  it("fluent-worker-redrive: Only the claimed worker drives", async () => {
    const subscriptionState = makeSubscriptionState({
      claimFailures: new Map([["b", "a"]]),
    })
    const driverState = makeDriverState()

    const resultA = await runWith(
      subscriptionState,
      driverState,
      handleFluentWorkerWake(wake, "a"),
    )
    const resultB = await runWith(
      subscriptionState,
      driverState,
      handleFluentWorkerWake(wake, "b"),
    )

    expect(resultA._tag).toBe("Completed")
    expect(resultB).toEqual({ _tag: "AlreadyClaimed", holder: "a" })
    expect(driverState.handledBy).toEqual(["a"])
  })

  it("fluent-worker-redrive: Claimed drive materializes durable state without acked_offset replay boundary", async () => {
    const subscriptionState = makeSubscriptionState({
      leaseStreams: [
        {
          path: "/v1/stream/fluent/sessions/session-1",
          ackedOffset: "100",
          tailOffset: "102",
        },
      ],
    })
    const committedEvents = [
      { offset: "0", value: "before-delivery-cursor" },
      { offset: "101", value: "after-delivery-cursor" },
      { offset: "102", value: "tail" },
    ]
    const driverState = makeDriverState({ events: committedEvents })

    const result = await runWith(
      subscriptionState,
      driverState,
      handleFluentWorkerWake(wake, "worker-1"),
    )

    expect(result._tag).toBe("Completed")
    expect(driverState.handledEvents[0]).toEqual(committedEvents)
    expect(subscriptionState.acks[0]).toEqual([
      {
        stream: "/v1/stream/fluent/sessions/session-1",
        offset: "102",
      },
    ])
  })

  it("fluent-worker-redrive: Restarted drive does not repeat journaled side effects", async () => {
    const subscriptionState = makeSubscriptionState()
    const journaledResult = {
      type: "tool.result",
      toolUseId: "tool-1",
      journaledResult: { ok: true },
    }
    const driverState = makeDriverState({ events: [journaledResult] })

    const result = await runWith(
      subscriptionState,
      driverState,
      handleFluentWorkerWake(wake, "worker-1"),
    )

    expect(result._tag).toBe("Completed")
    expect(driverState.replayedResults).toEqual([journaledResult])
    expect(driverState.sideEffectExecutions).toBe(0)
  })

  it("fluent-worker-redrive: Stale ack is fenced without advancing delivery", async () => {
    const subscriptionState = makeSubscriptionState({
      currentGeneration: 2,
      leaseGeneration: 1,
    })
    const driverState = makeDriverState()

    const result = await runWith(
      subscriptionState,
      driverState,
      handleFluentWorkerWake(wake, "worker-1"),
    )

    expect(result._tag).toBe("AckFenced")
    expect(subscriptionState.deliveryAdvanced).toBe(false)
    expect(subscriptionState.acks).toEqual([])
  })

  it("fluent-worker-redrive: Mid-turn arrivals schedule another wake", async () => {
    const subscriptionState = makeSubscriptionState({ nextWake: true })
    const driverState = makeDriverState()

    const result = await runWith(
      subscriptionState,
      driverState,
      handleFluentWorkerWake(wake, "worker-1"),
    )

    expect(result._tag).toBe("Completed")
    if (result._tag !== "Completed") {
      throw new FluentWorkerRuntimeError({ message: "Expected completed worker drive" })
    }
    expect(result.nextWake).toBe(true)
  })
})
