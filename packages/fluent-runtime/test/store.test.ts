// Test fixture: layers a fake `FetchHttpClient.Fetch` under the http client via two
// scoped provides — readable + correct for this package fixture.
// @effect-diagnostics effect/multipleEffectProvide:off
import { FetchHttpClient, type HttpClient } from "@effect/platform"
import { Effect, Layer, type Scope } from "effect"
import { describe, expect, it } from "vitest"
import { DurableStream } from "effect-durable-streams"
import { FluentRuntimeError, FluentSources, FluentSourcesLive, FluentStore, FluentStoreLive } from "../src/index.ts"

type Reqs = FetchHttpClient.Fetch | HttpClient.HttpClient | Scope.Scope | FluentStore | FluentSources

const lastOffset = (events: ReadonlyArray<unknown>): string =>
  events.length === 0 ? "-1" : String(events.length - 1)

const parseOffset = (raw: string | null): number =>
  raw === null || raw === "-1" ? -1 : Number(raw)

const makeMemoryDurableStreamsFetch = (): typeof globalThis.fetch => {
  interface StreamState {
    readonly events: Array<unknown>
    closed: boolean
    readonly producers: Map<string, { epoch: number; lastSeq: number }>
  }

  const streams = new Map<string, StreamState>()

  const streamHeaders = (stream: StreamState) => ({
    "content-type": "application/json",
    "stream-next-offset": lastOffset(stream.events),
    "stream-closed": String(stream.closed),
  })

  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    const streamKey = url.pathname
    const method = request.method.toUpperCase()

    if (method === "PUT") {
      const exists = streams.has(streamKey)
      if (!exists) {
        const forkedFrom = request.headers.get("stream-forked-from")
        const forkOffset = request.headers.get("stream-fork-offset")
        const parent = forkedFrom === null ? undefined : streams.get(forkedFrom)
        if (forkedFrom !== null && parent === undefined) {
          return new Response("", { status: 404 })
        }
        const forkEnd = forkOffset === null ? parent?.events.length ?? 0 : parseOffset(forkOffset) + 1
        const inheritedEvents = parent === undefined
          ? []
          : parent.events.slice(0, Math.max(0, forkEnd))
        streams.set(streamKey, {
          events: inheritedEvents.slice(),
          closed: false,
          producers: new Map(),
        })
      }
      const stream = streams.get(streamKey)
      return new Response("", {
        status: exists ? 200 : 201,
        headers: stream === undefined
          ? { "content-type": "application/json" }
          : streamHeaders(stream),
      })
    }

    const stream = streams.get(streamKey)
    if (stream === undefined) return new Response("", { status: 404 })

    if (method === "HEAD") {
      return new Response("", {
        status: 200,
        headers: streamHeaders(stream),
      })
    }

    if (method === "POST") {
      if (stream.closed) {
        return new Response("", {
          status: 409,
          headers: {
            "stream-next-offset": lastOffset(stream.events),
            "stream-closed": "true",
          },
        })
      }
      const body = await request.text()
      const parsed: unknown = body.trim() === "" ? [] : JSON.parse(body)
      const batch: ReadonlyArray<unknown> = Array.isArray(parsed) ? parsed : [parsed]
      const producerId = request.headers.get("producer-id")
      const producerEpoch = Number(request.headers.get("producer-epoch") ?? "0")
      const producerSeq = Number(request.headers.get("producer-seq") ?? "0")
      if (producerId !== null) {
        const current = stream.producers.get(producerId) ?? { epoch: 0, lastSeq: -1 }
        if (producerEpoch < current.epoch) {
          return new Response("", {
            status: 403,
            headers: {
              ...streamHeaders(stream),
              "producer-epoch": String(current.epoch),
            },
          })
        }
        const base = producerEpoch > current.epoch
          ? { epoch: producerEpoch, lastSeq: -1 }
          : current
        const expectedSeq = base.lastSeq + 1
        if (producerSeq < expectedSeq) {
          return new Response(null, {
            status: 204,
            headers: streamHeaders(stream),
          })
        }
        if (producerSeq > expectedSeq) {
          return new Response("", {
            status: 409,
            headers: {
              ...streamHeaders(stream),
              "producer-expected-seq": String(expectedSeq),
              "producer-received-seq": String(producerSeq),
            },
          })
        }
        stream.producers.set(producerId, {
          epoch: producerEpoch,
          lastSeq: producerSeq,
        })
      }
      for (let index = 0; index < batch.length; index += 1) {
        stream.events.push(batch[index])
      }
      if (request.headers.get("stream-closed") === "true") {
        stream.closed = true
      }
      return new Response("", {
        status: 200,
        headers: streamHeaders(stream),
      })
    }

    if (method === "GET") {
      const offset = parseOffset(url.searchParams.get("offset"))
      return new Response(JSON.stringify(stream.events.slice(offset + 1)), {
        status: 200,
        headers: {
          ...streamHeaders(stream),
          "stream-up-to-date": "true",
        },
      })
    }

    return new Response("", { status: 405 })
  }
}

const runtimeWith = <A, E>(
  fakeFetch: typeof globalThis.fetch,
  effect: Effect.Effect<A, E, Reqs>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(FluentSourcesLive),
        Effect.provide(FluentStoreLive({
          durableStreamsBaseUrl: "https://durable.example",
          namespace: "fluent-runtime-test",
        })),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(Layer.succeed(FetchHttpClient.Fetch, fakeFetch)),
      ),
    ),
  )

describe("@firegrid/fluent-runtime Store", () => {
  const prMergedPredicate =
    "event.type == \"github.pr\" && event.value.state == \"merged\" && event.value.issueId == self.issueId"

  it("fluent-runtime-workbench.STORE.2 fluent-runtime-workbench.STORE.3 completes a turn by append-and-close and reads closure", async () => {
    const fakeFetch = makeMemoryDurableStreamsFetch()

    const read = await runtimeWith(
      fakeFetch,
      Effect.gen(function* () {
        const store = yield* FluentStore
        yield* store.createSession({
          sessionId: "session-1",
          agent: "agent",
        })
        yield* store.startTurn({
          sessionId: "session-1",
          turnId: "turn-1",
          prompt: "hello",
        })
        yield* store.completeTurn({
          sessionId: "session-1",
          turnId: "turn-1",
          result: { ok: true },
        })
        return yield* store.readTurn("session-1", "turn-1")
      }),
    )

    expect(read.streamClosed).toBe(true)
    expect(read.events.map((event) => event.type)).toEqual([
      "turn.started",
      "turn.completed",
    ])
  })

  it("deduplicates fenced session appends by producer id epoch and 0-based seq", async () => {
    const fakeFetch = makeMemoryDurableStreamsFetch()

    const result = await runtimeWith(
      fakeFetch,
      Effect.gen(function* () {
        const store = yield* FluentStore
        yield* store.createSession({
          sessionId: "session-fenced",
          agent: "agent",
        })
        const first = yield* store.appendSessionEventFenced({
          sessionId: "session-fenced",
          name: "side-effect",
          payload: { value: "first" },
          fence: { producerId: "session-fenced-writer", epoch: 0, seq: 0 },
        })
        const duplicate = yield* store.appendSessionEventFenced({
          sessionId: "session-fenced",
          name: "side-effect",
          payload: { value: "duplicate" },
          fence: { producerId: "session-fenced-writer", epoch: 0, seq: 0 },
        })
        const events = yield* store.collectSession("session-fenced")
        return { first, duplicate, events }
      }),
    )

    expect(result.first.write._tag).toBe("Appended")
    expect(result.duplicate.write._tag).toBe("Duplicate")
    expect(result.events).toHaveLength(2)
    expect(result.events[1]).toEqual({
      type: "session.event_appended",
      sessionId: "session-fenced",
      name: "side-effect",
      payload: { value: "first" },
    })
  })

  it("rejects fenced session appends that skip the initial zero seq", async () => {
    const fakeFetch = makeMemoryDurableStreamsFetch()

    const exit = await runtimeWith(
      fakeFetch,
      Effect.gen(function* () {
        const store = yield* FluentStore
        yield* store.createSession({
          sessionId: "session-gap",
          agent: "agent",
        })
        return yield* store.appendSessionEventFenced({
          sessionId: "session-gap",
          name: "side-effect",
          payload: { value: "gap" },
          fence: { producerId: "session-gap-writer", epoch: 0, seq: 1 },
        }).pipe(Effect.exit)
      }),
    )

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(exit.cause._tag).toBe("Fail")
      if (exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(FluentRuntimeError)
        expect(exit.cause.error.cause).toBeInstanceOf(DurableStream.SequenceGap)
      }
    }
  })

  it("forks a child session from the parent stream path and records the fork on the parent", async () => {
    const fakeFetch = makeMemoryDurableStreamsFetch()

    const result = await runtimeWith(
      fakeFetch,
      Effect.gen(function* () {
        const store = yield* FluentStore
        yield* store.createSession({
          sessionId: "parent",
          agent: "agent",
        })
        yield* store.appendSessionEvent({
          sessionId: "parent",
          name: "before-a",
          payload: { n: 1 },
        })
        yield* store.appendSessionEvent({
          sessionId: "parent",
          name: "before-b",
          payload: { n: 2 },
        })
        const fork = yield* store.forkSession({
          parentSessionId: "parent",
          childSessionId: "child",
          forkOffset: "2",
        })
        yield* store.appendSessionEvent({
          sessionId: "parent",
          name: "after-fork",
          payload: { n: 3 },
        })
        const parent = yield* store.collectSession("parent")
        const child = yield* store.collectSession("child")
        return { fork, parent, child }
      }),
    )

    expect(result.fork._tag).toBe("Forked")
    expect(result.child.map((event) => event.type)).toEqual([
      "session.created",
      "session.event_appended",
      "session.event_appended",
    ])
    expect(result.child[1]).toEqual({
      type: "session.event_appended",
      sessionId: "parent",
      name: "before-a",
      payload: { n: 1 },
    })
    expect(result.child[2]).toEqual({
      type: "session.event_appended",
      sessionId: "parent",
      name: "before-b",
      payload: { n: 2 },
    })
    expect(result.parent.map((event) => event.type)).toEqual([
      "session.created",
      "session.event_appended",
      "session.event_appended",
      "session.forked",
      "session.event_appended",
    ])
  })

  it("fluent-fork-spawn.feature spawn creates a forked child stream with reset producer state", async () => {
    const fakeFetch = makeMemoryDurableStreamsFetch()

    const result = await runtimeWith(
      fakeFetch,
      Effect.gen(function* () {
        const store = yield* FluentStore
        yield* store.createSession({
          sessionId: "spawn-parent",
          agent: "agent",
        })
        yield* store.appendSessionEventFenced({
          sessionId: "spawn-parent",
          name: "parent-side-effect",
          payload: { parent: true },
          fence: { producerId: "shared-producer", epoch: 0, seq: 0 },
        })
        const spawned = yield* store.spawnChild({
          parentSessionId: "spawn-parent",
          toolCallId: "child-1",
          slot: 0,
          prompt: "work",
        })
        const childReset = yield* store.appendSessionEventFenced({
          sessionId: spawned.childSessionId,
          name: "child-side-effect",
          payload: { child: true },
          fence: { producerId: "shared-producer", epoch: 0, seq: 0 },
        })
        const parent = yield* store.collectSession("spawn-parent")
        const child = yield* store.collectSession(spawned.childSessionId)
        return { spawned, childReset, parent, child }
      }),
    )

    expect(result.spawned.childSessionId).toBe("spawn-parent/children/child-1/0")
    expect(result.spawned.initialWrite._tag).toBe("Appended")
    expect(result.childReset.write._tag).toBe("Appended")
    expect(result.child.map(event => event.type)).toEqual([
      "session.created",
      "session.event_appended",
      "session.event_appended",
      "session.event_appended",
    ])
    expect(result.child[1]).toEqual({
      type: "session.event_appended",
      sessionId: "spawn-parent",
      name: "parent-side-effect",
      payload: { parent: true },
    })
    expect(result.child[2]).toEqual({
      type: "session.event_appended",
      sessionId: "spawn-parent/children/child-1/0",
      name: "child.prompt",
      payload: { prompt: "work" },
    })
    expect(result.parent.some(event => event.type === "session.child_spawned")).toBe(true)
  })

  it("fluent-fork-spawn.feature parent waits on child result event without an inline child handler call", async () => {
    const fakeFetch = makeMemoryDurableStreamsFetch()

    const result = await runtimeWith(
      fakeFetch,
      Effect.gen(function* () {
        const store = yield* FluentStore
        yield* store.createSession({
          sessionId: "join-parent",
          agent: "agent",
        })
        yield* store.startTurn({
          sessionId: "join-parent",
          turnId: "join-turn",
          prompt: "spawn",
        })
        const spawned = yield* store.spawnChild({
          parentSessionId: "join-parent",
          toolCallId: "child-1",
          slot: 0,
          prompt: "work",
        })
        const pending = yield* store.joinChildResult({
          parentSessionId: "join-parent",
          turnId: "join-turn",
          childSessionId: spawned.childSessionId,
          resultId: "child-1",
        })
        const published = yield* store.publishChildResult({
          parentSessionId: "join-parent",
          childSessionId: spawned.childSessionId,
          resultId: "child-1",
          result: "done",
        })
        const matched = yield* store.joinChildResult({
          parentSessionId: "join-parent",
          turnId: "join-turn",
          childSessionId: spawned.childSessionId,
          resultId: "child-1",
        })
        const turn = yield* store.readTurn("join-parent", "join-turn")
        return { pending, published, matched, turn }
      }),
    )

    expect(result.pending._tag).toBe("Pending")
    expect(result.published.write._tag).toBe("Appended")
    expect(result.matched._tag).toBe("Matched")
    if (result.matched._tag === "Matched") {
      expect(result.matched.childResult.result).toBe("done")
      expect(result.matched.matched.event).toEqual(result.matched.childResult)
    }
    expect(result.turn.events.map(event => event.type)).toEqual([
      "turn.started",
      "turn.wait_registered",
      "turn.wait_matched",
    ])
  })

  it("fluent-fork-spawn.feature spawn_all creates deterministic child identities and joins all results", async () => {
    const fakeFetch = makeMemoryDurableStreamsFetch()

    const result = await runtimeWith(
      fakeFetch,
      Effect.gen(function* () {
        const store = yield* FluentStore
        yield* store.createSession({
          sessionId: "spawn-all-parent",
          agent: "agent",
        })
        yield* store.startTurn({
          sessionId: "spawn-all-parent",
          turnId: "spawn-all-turn",
          prompt: "spawn_all",
        })
        const spawned = yield* store.spawnAll({
          parentSessionId: "spawn-all-parent",
          toolCallId: "call-123",
          tasks: [{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }],
        })
        yield* Effect.forEach(spawned.children, (child, index) =>
          store.publishChildResult({
            parentSessionId: "spawn-all-parent",
            childSessionId: child.childSessionId,
            resultId: `result-${index}`,
            result: ["a", "b", "c"][index],
          }), { discard: true })
        const joins = yield* Effect.forEach(spawned.children, (child, index) =>
          store.joinChildResult({
            parentSessionId: "spawn-all-parent",
            turnId: "spawn-all-turn",
            childSessionId: child.childSessionId,
            resultId: `result-${index}`,
          }))
        return { spawned, joins }
      }),
    )

    expect(result.spawned.children.map(child => child.childSessionId)).toEqual([
      "spawn-all-parent/children/call-123/0",
      "spawn-all-parent/children/call-123/1",
      "spawn-all-parent/children/call-123/2",
    ])
    expect(result.joins.map(join => join._tag)).toEqual(["Matched", "Matched", "Matched"])
  })

  it("fluent-fork-spawn.feature child race winner records explicit loser policy", async () => {
    const fakeFetch = makeMemoryDurableStreamsFetch()

    const result = await runtimeWith(
      fakeFetch,
      Effect.gen(function* () {
        const store = yield* FluentStore
        yield* store.createSession({
          sessionId: "race-parent",
          agent: "agent",
        })
        const spawned = yield* store.spawnAll({
          parentSessionId: "race-parent",
          toolCallId: "race-call",
          tasks: [{ prompt: "fast" }, { prompt: "slow" }],
        })
        yield* store.publishChildResult({
          parentSessionId: "race-parent",
          childSessionId: spawned.children[0]!.childSessionId,
          resultId: "race-fast",
          result: "fast",
        })
        yield* store.recordChildRaceWinner({
          parentSessionId: "race-parent",
          raceId: "race-1",
          winnerChildSessionId: spawned.children[0]!.childSessionId,
          loserPolicy: "let_finish",
        })
        return yield* store.collectSession("race-parent")
      }),
    )

    expect(result.at(-1)).toEqual({
      type: "session.child_race_winner",
      parentSessionId: "race-parent",
      raceId: "race-1",
      winnerChildSessionId: "race-parent/children/race-call/0",
      loserPolicy: "let_finish",
    })
  })

  it("records durable timer intent and dedupes timer-source fire events", async () => {
    const fakeFetch = makeMemoryDurableStreamsFetch()

    const result = await runtimeWith(
      fakeFetch,
      Effect.gen(function* () {
        const store = yield* FluentStore
        yield* store.createSession({
          sessionId: "timer-session",
          agent: "agent",
        })
        yield* store.startTurn({
          sessionId: "timer-session",
          turnId: "turn-timer",
          prompt: "wait",
        })
        const schedule = yield* store.scheduleTurnTimer({
          sessionId: "timer-session",
          turnId: "turn-timer",
          timerId: "sleep-1",
          fireAtEpochMs: 1_000,
        })
        const duplicateSchedule = yield* store.scheduleTurnTimer({
          sessionId: "timer-session",
          turnId: "turn-timer",
          timerId: "sleep-1",
          fireAtEpochMs: 1_000,
        })
        const first = yield* store.fireTurnTimer({
          sessionId: "timer-session",
          turnId: "turn-timer",
          timerId: "sleep-1",
          firedAtEpochMs: 1_000,
        })
        const duplicate = yield* store.fireTurnTimer({
          sessionId: "timer-session",
          turnId: "turn-timer",
          timerId: "sleep-1",
          firedAtEpochMs: 1_000,
        })
        yield* store.scheduleTurnTimer({
          sessionId: "timer-session",
          turnId: "turn-timer",
          timerId: "sleep-2",
          fireAtEpochMs: 2_000,
        })
        const secondTimer = yield* store.fireTurnTimer({
          sessionId: "timer-session",
          turnId: "turn-timer",
          timerId: "sleep-2",
          firedAtEpochMs: 2_000,
        })
        const read = yield* store.readTurn("timer-session", "turn-timer")
        return { schedule, duplicateSchedule, first, duplicate, secondTimer, read }
      }),
    )

    expect(result.schedule.write._tag).toBe("Appended")
    expect(result.duplicateSchedule.write._tag).toBe("Duplicate")
    expect(result.first.write._tag).toBe("Appended")
    expect(result.duplicate.write._tag).toBe("Duplicate")
    expect(result.secondTimer.write._tag).toBe("Appended")
    expect(result.read.events.map((event) => event.type)).toEqual([
      "turn.started",
      "turn.timer_scheduled",
      "turn.timer_fired",
      "turn.timer_scheduled",
      "turn.timer_fired",
    ])
    expect(result.read.events[1]).toEqual({
      type: "turn.timer_scheduled",
      sessionId: "timer-session",
      turnId: "turn-timer",
      timerId: "sleep-1",
      fireAtEpochMs: 1_000,
    })
    expect(result.read.events[2]).toEqual({
      type: "turn.timer_fired",
      sessionId: "timer-session",
      turnId: "turn-timer",
      timerId: "sleep-1",
      firedAtEpochMs: 1_000,
    })
    expect(result.read.events[3]).toEqual({
      type: "turn.timer_scheduled",
      sessionId: "timer-session",
      turnId: "turn-timer",
      timerId: "sleep-2",
      fireAtEpochMs: 2_000,
    })
    expect(result.read.events[4]).toEqual({
      type: "turn.timer_fired",
      sessionId: "timer-session",
      turnId: "turn-timer",
      timerId: "sleep-2",
      firedAtEpochMs: 2_000,
    })
  })

  it("parks durable sleep as a replayed timer intent and resumes after timer source fire", async () => {
    const fakeFetch = makeMemoryDurableStreamsFetch()

    const result = await runtimeWith(
      fakeFetch,
      Effect.gen(function* () {
        const store = yield* FluentStore
        yield* store.createSession({
          sessionId: "sleep-session",
          agent: "agent",
        })
        yield* store.startTurn({
          sessionId: "sleep-session",
          turnId: "sleep-turn",
          prompt: "sleep",
        })
        const parked = yield* store.durableSleep({
          sessionId: "sleep-session",
          turnId: "sleep-turn",
          timerId: "sleep-wait",
          fireAtEpochMs: 10_000,
        })
        yield* store.fireTurnTimer({
          sessionId: "sleep-session",
          turnId: "sleep-turn",
          timerId: "sleep-wait",
          firedAtEpochMs: 10_000,
        })
        const replayed = yield* store.durableSleep({
          sessionId: "sleep-session",
          turnId: "sleep-turn",
          timerId: "sleep-wait",
          fireAtEpochMs: 10_000,
        })
        const read = yield* store.readTurn("sleep-session", "sleep-turn")
        return { parked, replayed, read }
      }),
    )

    expect(result.parked._tag).toBe("Pending")
    expect(result.replayed._tag).toBe("Fired")
    expect(result.read.events.map((event) => event.type)).toEqual([
      "turn.started",
      "turn.timer_scheduled",
      "turn.timer_fired",
    ])
  })

  it("materializes only due timers from the timer source and reports replayed fires", async () => {
    const fakeFetch = makeMemoryDurableStreamsFetch()

    const result = await runtimeWith(
      fakeFetch,
      Effect.gen(function* () {
        const store = yield* FluentStore
        const sources = yield* FluentSources
        yield* store.createSession({
          sessionId: "timer-source-session",
          agent: "agent",
        })
        yield* store.startTurn({
          sessionId: "timer-source-session",
          turnId: "timer-source-turn",
          prompt: "source",
        })
        yield* store.durableSleep({
          sessionId: "timer-source-session",
          turnId: "timer-source-turn",
          timerId: "due",
          fireAtEpochMs: 100,
        })
        yield* store.durableSleep({
          sessionId: "timer-source-session",
          turnId: "timer-source-turn",
          timerId: "later",
          fireAtEpochMs: 500,
        })
        const first = yield* sources.fireDueTurnTimers({
          sessionId: "timer-source-session",
          turnId: "timer-source-turn",
          nowEpochMs: 150,
        })
        const second = yield* sources.fireDueTurnTimers({
          sessionId: "timer-source-session",
          turnId: "timer-source-turn",
          nowEpochMs: 150,
        })
        const read = yield* store.readTurn("timer-source-session", "timer-source-turn")
        return { first, second, read }
      }),
    )

    expect(result.first.fired).toEqual([
      {
        timerId: "due",
        fireAtEpochMs: 100,
        firedAtEpochMs: 150,
        write: { _tag: "Appended", offset: "3" },
      },
    ])
    expect(result.first.pending).toEqual([{ timerId: "later", fireAtEpochMs: 500 }])
    expect(result.first.alreadyFired).toEqual([])
    expect(result.second.fired).toEqual([])
    expect(result.second.pending).toEqual([{ timerId: "later", fireAtEpochMs: 500 }])
    expect(result.second.alreadyFired).toEqual([{
      timerId: "due",
      fireAtEpochMs: 100,
      firedAtEpochMs: 150,
    }])
    expect(result.read.events.map((event) => event.type)).toEqual([
      "turn.started",
      "turn.timer_scheduled",
      "turn.timer_scheduled",
      "turn.timer_fired",
    ])
  })

  it("registers durable wait before park and resolves from a matched event on replay", async () => {
    const fakeFetch = makeMemoryDurableStreamsFetch()

    const result = await runtimeWith(
      fakeFetch,
      Effect.gen(function* () {
        const store = yield* FluentStore
        yield* store.createSession({
          sessionId: "wait-session",
          agent: "agent",
        })
        yield* store.startTurn({
          sessionId: "wait-session",
          turnId: "wait-turn",
          prompt: "wait_for",
        })
        const pending = yield* store.durableWait({
          sessionId: "wait-session",
          turnId: "wait-turn",
          waitId: "github-pr-merged",
          predicate: prMergedPredicate,
          afterOffset: "3",
          self: { issueId: "ISS-1" },
        })
        const staleOffset = yield* store.matchTurnWait({
          sessionId: "wait-session",
          turnId: "wait-turn",
          waitId: "github-pr-merged",
          matchedOffset: "3",
          event: {
            type: "github.pr",
            key: "pr-000",
            value: { state: "merged", issueId: "ISS-1" },
            headers: { operation: "update" },
          },
        })
        const nonMatch = yield* store.matchTurnWait({
          sessionId: "wait-session",
          turnId: "wait-turn",
          waitId: "github-pr-merged",
          matchedOffset: "4",
          event: {
            type: "github.pr",
            key: "pr-456",
            value: { state: "merged", issueId: "ISS-2" },
            headers: { operation: "update" },
          },
        })
        const match = yield* store.matchTurnWait({
          sessionId: "wait-session",
          turnId: "wait-turn",
          waitId: "github-pr-merged",
          matchedOffset: "5",
          event: {
            type: "github.pr",
            key: "pr-123",
            value: { state: "merged", issueId: "ISS-1" },
            headers: { operation: "update" },
          },
        })
        const matched = yield* store.durableWait({
          sessionId: "wait-session",
          turnId: "wait-turn",
          waitId: "github-pr-merged",
          predicate: prMergedPredicate,
          afterOffset: "3",
          self: { issueId: "ISS-1" },
        })
        const read = yield* store.readTurn("wait-session", "wait-turn")
        return { pending, staleOffset, nonMatch, match, matched, read }
      }),
    )

    expect(result.pending._tag).toBe("Pending")
    expect(result.staleOffset._tag).toBe("NotMatched")
    expect(result.nonMatch._tag).toBe("NotMatched")
    expect(result.match._tag).toBe("Matched")
    if (result.match._tag === "Matched") {
      expect(result.match.write._tag).toBe("Appended")
    }
    expect(result.matched._tag).toBe("Matched")
    expect(result.read.events.map((event) => event.type)).toEqual([
      "turn.started",
      "turn.wait_registered",
      "turn.wait_matched",
    ])
    expect(result.read.events[1]).toEqual({
      type: "turn.wait_registered",
      sessionId: "wait-session",
      turnId: "wait-turn",
      waitId: "github-pr-merged",
      predicate: prMergedPredicate,
      afterOffset: "3",
      self: { issueId: "ISS-1" },
    })
    expect(result.read.events[2]).toEqual({
      type: "turn.wait_matched",
      sessionId: "wait-session",
      turnId: "wait-turn",
      waitId: "github-pr-merged",
      matchedOffset: "5",
      event: {
        type: "github.pr",
        key: "pr-123",
        value: { state: "merged", issueId: "ISS-1" },
        headers: { operation: "update" },
      },
    })
  })

  it("fans one candidate event across pending CEL waits from the wait source", async () => {
    const fakeFetch = makeMemoryDurableStreamsFetch()

    const result = await runtimeWith(
      fakeFetch,
      Effect.gen(function* () {
        const store = yield* FluentStore
        const sources = yield* FluentSources
        yield* store.createSession({
          sessionId: "wait-source-session",
          agent: "agent",
        })
        yield* store.startTurn({
          sessionId: "wait-source-session",
          turnId: "wait-source-turn",
          prompt: "wait_for",
        })
        yield* store.durableWait({
          sessionId: "wait-source-session",
          turnId: "wait-source-turn",
          waitId: "issue-1",
          predicate: prMergedPredicate,
          afterOffset: "10",
          self: { issueId: "ISS-1" },
        })
        yield* store.durableWait({
          sessionId: "wait-source-session",
          turnId: "wait-source-turn",
          waitId: "issue-2",
          predicate: prMergedPredicate,
          afterOffset: "10",
          self: { issueId: "ISS-2" },
        })
        const stale = yield* sources.matchPendingTurnWaits({
          sessionId: "wait-source-session",
          turnId: "wait-source-turn",
          matchedOffset: "10",
          event: {
            type: "github.pr",
            key: "pr-123",
            value: { state: "merged", issueId: "ISS-1" },
            headers: { operation: "update" },
          },
        })
        const first = yield* sources.matchPendingTurnWaits({
          sessionId: "wait-source-session",
          turnId: "wait-source-turn",
          matchedOffset: "11",
          event: {
            type: "github.pr",
            key: "pr-123",
            value: { state: "merged", issueId: "ISS-1" },
            headers: { operation: "update" },
          },
        })
        const second = yield* sources.matchPendingTurnWaits({
          sessionId: "wait-source-session",
          turnId: "wait-source-turn",
          matchedOffset: "12",
          event: {
            type: "github.pr",
            key: "pr-456",
            value: { state: "merged", issueId: "ISS-2" },
            headers: { operation: "update" },
          },
        })
        const read = yield* store.readTurn("wait-source-session", "wait-source-turn")
        return { stale, first, second, read }
      }),
    )

    expect(result.stale.matched).toEqual([])
    expect(result.stale.notMatched).toEqual([{ waitId: "issue-1" }, { waitId: "issue-2" }])
    expect(result.first.matched).toEqual([{ waitId: "issue-1", write: { _tag: "Appended", offset: "3" } }])
    expect(result.first.notMatched).toEqual([{ waitId: "issue-2" }])
    expect(result.second.matched).toEqual([{ waitId: "issue-2", write: { _tag: "Appended", offset: "4" } }])
    expect(result.second.alreadyMatched).toEqual([{ waitId: "issue-1", matchedOffset: "11" }])
    expect(result.read.events.map((event) => event.type)).toEqual([
      "turn.started",
      "turn.wait_registered",
      "turn.wait_registered",
      "turn.wait_matched",
      "turn.wait_matched",
    ])
  })
})
