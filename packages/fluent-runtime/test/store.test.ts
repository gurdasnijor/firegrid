// Test fixture: layers a fake `FetchHttpClient.Fetch` under the http client via two
// scoped provides — readable + correct for this package fixture.
// @effect-diagnostics effect/multipleEffectProvide:off
import { FetchHttpClient, type HttpClient } from "@effect/platform"
import { Effect, Layer, type Scope } from "effect"
import { describe, expect, it } from "vitest"
import { FluentStore, FluentStoreLive } from "../src/index.ts"

type Reqs = FetchHttpClient.Fetch | HttpClient.HttpClient | Scope.Scope | FluentStore

const lastOffset = (events: ReadonlyArray<unknown>): string =>
  events.length === 0 ? "-1" : String(events.length - 1)

const parseOffset = (raw: string | null): number =>
  raw === null || raw === "-1" ? -1 : Number(raw)

const makeMemoryDurableStreamsFetch = (): typeof globalThis.fetch => {
  const streams = new Map<string, {
    readonly events: Array<unknown>
    closed: boolean
  }>()

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
      if (!exists) streams.set(streamKey, { events: [], closed: false })
      const stream = streams.get(streamKey)
      return new Response("", {
        status: exists ? 200 : 201,
        headers: {
          "content-type": "application/json",
          "stream-next-offset": lastOffset(stream?.events ?? []),
          "stream-closed": String(stream?.closed === true),
        },
      })
    }

    const stream = streams.get(streamKey)
    if (stream === undefined) return new Response("", { status: 404 })

    if (method === "HEAD") {
      return new Response("", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "stream-next-offset": lastOffset(stream.events),
          "stream-closed": String(stream.closed),
        },
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
      for (let index = 0; index < batch.length; index += 1) {
        stream.events.push(batch[index])
      }
      if (request.headers.get("stream-closed") === "true") {
        stream.closed = true
      }
      return new Response("", {
        status: 200,
        headers: {
          "stream-next-offset": lastOffset(stream.events),
          "stream-closed": String(stream.closed),
        },
      })
    }

    if (method === "GET") {
      const offset = parseOffset(url.searchParams.get("offset"))
      return new Response(JSON.stringify(stream.events.slice(offset + 1)), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "stream-next-offset": lastOffset(stream.events),
          "stream-up-to-date": "true",
          "stream-closed": String(stream.closed),
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
})
