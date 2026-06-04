// Test fixture: layers a fake `FetchHttpClient.Fetch` under the http client via two
// scoped provides — readable + correct; the production "combine provides" advice
// doesn't apply here.
// @effect-diagnostics effect/multipleEffectProvide:off
import { FetchHttpClient, type HttpClient } from "@effect/platform"
import { Effect, Layer, type Scope } from "effect"
import { describe, expect, it } from "vitest"
import { client, execute, gen, run, service } from "../src/index.ts"

type Reqs = FetchHttpClient.Fetch | HttpClient.HttpClient | Scope.Scope

const lastOffset = (events: ReadonlyArray<unknown>): string =>
  events.length === 0 ? "-1" : String(events.length - 1)

const parseOffset = (raw: string | null): number =>
  raw === null || raw === "-1" ? -1 : Number(raw)

const makeMemoryDurableStreamsFetch = (): typeof globalThis.fetch => {
  const streams = new Map<string, Array<unknown>>()
  const fetchImpl: typeof globalThis.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    const streamKey = url.pathname
    const method = request.method.toUpperCase()

    if (method === "PUT") {
      const exists = streams.has(streamKey)
      if (!exists) streams.set(streamKey, [])
      return new Response("", {
        status: exists ? 200 : 201,
        headers: {
          "content-type": "application/json",
          "stream-next-offset": lastOffset(streams.get(streamKey) ?? []),
        },
      })
    }

    const events = streams.get(streamKey)
    if (events === undefined) {
      return new Response("", { status: 404 })
    }

    if (method === "POST") {
      const body = await request.text()
      const parsed: unknown = body.trim() === "" ? [] : JSON.parse(body)
      const batch: ReadonlyArray<unknown> = Array.isArray(parsed) ? parsed : [parsed]
      for (const event of batch) {
        events.push(event)
      }
      return new Response("", {
        status: 200,
        headers: { "stream-next-offset": lastOffset(events) },
      })
    }

    if (method === "GET") {
      const offset = parseOffset(url.searchParams.get("offset"))
      const items = events.slice(offset + 1)
      return new Response(JSON.stringify(items), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "stream-next-offset": lastOffset(events),
          "stream-up-to-date": "true",
        },
      })
    }

    return new Response("", { status: 405 })
  }
  return fetchImpl
}

const runtimeWith = <A, E>(
  fakeFetch: typeof globalThis.fetch,
  effect: Effect.Effect<A, E, Reqs>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(Layer.succeed(FetchHttpClient.Fetch, fakeFetch)),
      ),
    ),
  )

describe("@firegrid/fluent-firegrid Operation/Future run keystone", () => {
  it("fluent-firegrid-keystone.PACKAGE.4 fluent-firegrid-keystone.DURABLE_RUN.1 fluent-firegrid-keystone.DURABLE_RUN.3 replays a journaled run Future after restart", async () => {
    const fakeFetch = makeMemoryDurableStreamsFetch()
    const executions = { count: 0 }
    const greeter = service({
      name: "greeter",
      handlers: {
        greet: (ctx, name: string) =>
          execute(
            ctx,
            gen(function* () {
              const greeting = yield* run(() => {
                executions.count += 1
                return `Hello, ${name}! run=${executions.count}`
              }, { name: "compose" })
              return greeting
            }),
          ),
      },
    })
    const invocation = {
      journal: {
        endpoint: {
          url: "https://journal.example/v1/stream/greeter/greet/invocation-1",
        },
      },
    }

    const firstClient = client(greeter, invocation)
    const first = await runtimeWith(fakeFetch, firstClient.greet("Ada"))

    const restartedClient = client(greeter, invocation)
    const replayed = await runtimeWith(fakeFetch, restartedClient.greet("Ada"))

    expect(first).toBe("Hello, Ada! run=1")
    expect(replayed).toBe("Hello, Ada! run=1")
    expect(executions.count).toBe(1)
  })
})
