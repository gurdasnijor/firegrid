// Test fixture: layers a fake `FetchHttpClient.Fetch` under the http client via two
// scoped provides — readable + correct for this package fixture.
// @effect-diagnostics effect/multipleEffectProvide:off
import { FetchHttpClient, type HttpClient } from "@effect/platform"
import { Effect, Layer, type Scope } from "effect"
import { describe, expect, it } from "vitest"
import { DurableStream } from "effect-durable-streams"
import { FluentRuntimeError, FluentStore, FluentStoreLive } from "../src/index.ts"

type Reqs = FetchHttpClient.Fetch | HttpClient.HttpClient | Scope.Scope | FluentStore

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
        const inheritedEvents = parent === undefined
          ? []
          : parent.events.slice(0, Math.max(0, Number(forkOffset ?? "0")))
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
    ])
    expect(result.child[1]).toEqual({
      type: "session.event_appended",
      sessionId: "parent",
      name: "before-a",
      payload: { n: 1 },
    })
    expect(result.parent.map((event) => event.type)).toEqual([
      "session.created",
      "session.event_appended",
      "session.event_appended",
      "session.forked",
      "session.event_appended",
    ])
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
})
