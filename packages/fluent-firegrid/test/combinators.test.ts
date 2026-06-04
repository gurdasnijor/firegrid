// Test fixture: layers a fake `FetchHttpClient.Fetch` under the http client via two
// scoped provides — readable + correct for this package fixture.
// @effect-diagnostics effect/multipleEffectProvide:off
import { FetchHttpClient, type HttpClient } from "@effect/platform"
import { Data, Effect, Layer, type Scope } from "effect"
import { describe, expect, it } from "vitest"
import {
  all,
  allSettled,
  any,
  client,
  execute,
  gen,
  race,
  run,
  select,
  service,
  sleep,
  spawn,
} from "../src/index.ts"

type Reqs = FetchHttpClient.Fetch | HttpClient.HttpClient | Scope.Scope

class TestFailure extends Data.TaggedError("TestFailure")<{
  readonly message: string
}> {}

const lastOffset = (events: ReadonlyArray<unknown>): string =>
  events.length === 0 ? "-1" : String(events.length - 1)

const parseOffset = (raw: string | null): number =>
  raw === null || raw === "-1" ? -1 : Number(raw)

const makeMemoryDurableStreamsFetch = (): typeof globalThis.fetch => {
  const streams = new Map<string, Array<unknown>>()
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
    if (events === undefined) return new Response("", { status: 404 })

    if (method === "POST") {
      const body = await request.text()
      const parsed: unknown = body.trim() === "" ? [] : JSON.parse(body)
      const batch: ReadonlyArray<unknown> = Array.isArray(parsed) ? parsed : [parsed]
      for (const event of batch) events.push(event)
      return new Response("", {
        status: 200,
        headers: { "stream-next-offset": lastOffset(events) },
      })
    }

    if (method === "GET") {
      const offset = parseOffset(url.searchParams.get("offset"))
      return new Response(JSON.stringify(events.slice(offset + 1)), {
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

const invocation = (name: string) => ({
  journal: {
    endpoint: {
      url: `https://journal.example/v1/stream/combinators/${name}`,
    },
  },
})

describe("@firegrid/fluent-firegrid sdk-gen combinator slice", () => {
  it("fluent-firegrid-keystone.FREE.5 races Futures and returns the first settled value", async () => {
    const fakeFetch = makeMemoryDurableStreamsFetch()
    const svc = service({
      name: "raceSvc",
      handlers: {
        runRace: (ctx, _: void) =>
          execute(
            ctx,
            gen(function* () {
              const slow = run(
                () => Effect.as(Effect.sleep(20), "slow"),
                { name: "slow" },
              )
              const fast = run(
                () => Effect.as(Effect.sleep(1), "fast"),
                { name: "fast" },
              )
              return yield* race([slow, fast])
            }),
          ),
      },
    })

    await expect(runtimeWith(fakeFetch, client(svc, invocation("race")).runRace(undefined)))
      .resolves.toBe("fast")
  })

  it("fluent-firegrid-keystone.FREE.5 keeps race losers running and replays their journals", async () => {
    const fakeFetch = makeMemoryDurableStreamsFetch()
    const executions = { fast: 0, slow: 0 }
    const svc = service({
      name: "raceReplaySvc",
      handlers: {
        hedge: (ctx, _: void) =>
          execute(
            ctx,
            gen(function* () {
              const slow = run(
                () => {
                  executions.slow += 1
                  return Effect.as(Effect.sleep(5), "slow")
                },
                { name: "slow" },
              )
              const fast = run(
                () => {
                  executions.fast += 1
                  return Effect.as(Effect.sleep(1), "fast")
                },
                { name: "fast" },
              )
              const winner = yield* race([slow, fast])
              yield* sleep(10, "let-loser-finish")
              return winner
            }),
          ),
      },
    })

    const ctx = invocation("race-replay")
    await expect(runtimeWith(fakeFetch, client(svc, ctx).hedge(undefined)))
      .resolves.toBe("fast")
    expect(executions).toEqual({ fast: 1, slow: 1 })

    await expect(runtimeWith(fakeFetch, client(svc, ctx).hedge(undefined)))
      .resolves.toBe("fast")
    expect(executions).toEqual({ fast: 1, slow: 1 })
  })

  it("fluent-firegrid-keystone.FREE.5 returns first successful any result and aggregates all failures", async () => {
    const fakeFetch = makeMemoryDurableStreamsFetch()
    const svc = service({
      name: "anySvc",
      handlers: {
        firstSuccess: (ctx, _: void) =>
          execute(
            ctx,
            gen(function* () {
              const failed = run(
                () => Effect.fail(new TestFailure({ message: "nope" })),
                { name: "failed" },
              )
              const ok = run(() => "ok", { name: "ok" })
              return yield* any([failed, ok])
            }),
          ),
        allFail: (ctx, _: void) =>
          execute(
            ctx,
            gen(function* () {
              const a = run(
                () => Effect.fail(new TestFailure({ message: "a" })),
                { name: "a" },
              )
              const b = run(
                () => Effect.fail(new TestFailure({ message: "b" })),
                { name: "b" },
              )
              try {
                yield* any([a, b])
                return "unexpected"
              } catch (error) {
                return error instanceof AggregateError
                  ? error.errors.map((item) => (item as Error).message).join(",")
                  : "wrong"
              }
            }),
          ),
      },
    })

    await expect(runtimeWith(fakeFetch, client(svc, invocation("any-ok")).firstSuccess(undefined)))
      .resolves.toBe("ok")
    await expect(runtimeWith(fakeFetch, client(svc, invocation("any-fail")).allFail(undefined)))
      .resolves.toBe("a,b")
  })

  it("fluent-firegrid-keystone.FREE.5 allSettled captures fulfilled and rejected results in order", async () => {
    const fakeFetch = makeMemoryDurableStreamsFetch()
    const svc = service({
      name: "settledSvc",
      handlers: {
        settle: (ctx, _: void) =>
          execute(
            ctx,
            gen(function* () {
              const out = yield* allSettled([
                run(() => "a", { name: "a" }),
                run(
                  () => Effect.fail(new TestFailure({ message: "middle" })),
                  { name: "middle" },
                ),
                run(() => "c", { name: "c" }),
              ])
              return out.map((item) =>
                item.status === "fulfilled" ? item.value : (item.reason as Error).message,
              ).join("|")
            }),
          ),
      },
    })

    await expect(runtimeWith(fakeFetch, client(svc, invocation("settled")).settle(undefined)))
      .resolves.toBe("a|middle|c")
  })

  it("fluent-firegrid-keystone.FREE.6 select returns the winning tag and Future", async () => {
    const fakeFetch = makeMemoryDurableStreamsFetch()
    const svc = service({
      name: "selectSvc",
      handlers: {
        choose: (ctx, _: void) =>
          execute(
            ctx,
            gen(function* () {
              const selected = yield* select({
                slow: run(() => Effect.as(Effect.sleep(20), "slow"), { name: "slow" }),
                fast: run(() => Effect.as(Effect.sleep(1), "fast"), { name: "fast" }),
              })
              const value = yield* selected.future
              return `${String(selected.tag)}:${value}`
            }),
          ),
      },
    })

    await expect(runtimeWith(fakeFetch, client(svc, invocation("select")).choose(undefined)))
      .resolves.toBe("fast:fast")
  })

  it("fluent-firegrid-keystone.FREE.7 spawn returns a routine-backed Future", async () => {
    const fakeFetch = makeMemoryDurableStreamsFetch()
    const svc = service({
      name: "spawnSvc",
      handlers: {
        nested: (ctx, input: number) =>
          execute(
            ctx,
            gen(function* () {
              const child = spawn(gen(function* () {
                const [left, right] = yield* all([
                  run(() => input + 1, { name: "left" }),
                  run(() => input + 2, { name: "right" }),
                ])
                return left + right
              }))
              return (yield* child) + 1
            }),
          ),
      },
    })

    await expect(runtimeWith(fakeFetch, client(svc, invocation("spawn")).nested(10)))
      .resolves.toBe(24)
  })
})
