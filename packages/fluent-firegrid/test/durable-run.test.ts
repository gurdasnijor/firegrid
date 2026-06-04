// Test fixture: layers a fake `FetchHttpClient.Fetch` under the http client via two
// scoped provides — readable + correct; the production "combine provides" advice
// doesn't apply here.
// @effect-diagnostics effect/multipleEffectProvide:off
import { FetchHttpClient, type HttpClient } from "@effect/platform"
import { Effect, Layer, type Scope } from "effect"
import { describe, expect, it } from "vitest"
import {
  all,
  client,
  execute,
  gen,
  object,
  run,
  service,
  sharedState,
  sleep,
  state,
  workflow,
} from "../src/index.ts"

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

  it("fluent-firegrid-keystone.FREE.1 fluent-firegrid-keystone.FREE.2 replays ordered all results", async () => {
    const fakeFetch = makeMemoryDurableStreamsFetch()
    const executions = { count: 0 }
    const calculator = service({
      name: "calculator",
      handlers: {
        addPair: (base: number) =>
          gen(function* () {
            const left = run(() => {
              executions.count += 1
              return base + 1
            }, { name: "left" })
            const right = run(() => {
              executions.count += 1
              return base + 2
            }, { name: "right" })
            const [leftValue, rightValue] = yield* all([left, right])
            return leftValue + rightValue
          }),
      },
    })
    const invocation = {
      journal: {
        endpoint: {
          url: "https://journal.example/v1/stream/calculator/add-pair/invocation-1",
        },
      },
    }

    const first = await runtimeWith(fakeFetch, client(calculator, invocation).addPair(10))
    const replayed = await runtimeWith(fakeFetch, client(calculator, invocation).addPair(10))

    expect(first).toBe(23)
    expect(replayed).toBe(23)
    expect(executions.count).toBe(2)
  })

  it("fluent-firegrid-keystone.FREE.4 memoizes a Future yielded more than once", async () => {
    const fakeFetch = makeMemoryDurableStreamsFetch()
    const executions = { count: 0 }
    const memo = service({
      name: "memo",
      handlers: {
        duplicate: (base: number) =>
          gen(function* () {
            const once = run(() => {
              executions.count += 1
              return base + executions.count
            }, { name: "once" })
            const [left, right] = yield* all([once, once])
            const again = yield* once
            return `${left}:${right}:${again}`
          }),
      },
    })
    const invocation = {
      journal: {
        endpoint: {
          url: "https://journal.example/v1/stream/memo/duplicate/invocation-1",
        },
      },
    }

    const result = await runtimeWith(fakeFetch, client(memo, invocation).duplicate(40))

    expect(result).toBe("41:41:41")
    expect(executions.count).toBe(1)
  })

  it("fluent-firegrid-keystone.FREE.3 replays a journaled sleep without waiting again", async () => {
    const fakeFetch = makeMemoryDurableStreamsFetch()
    const timer = service({
      name: "timer",
      handlers: {
        pause: (label: string) =>
          gen(function* () {
            yield* sleep(500, "settle")
            return `paused:${label}`
          }),
      },
    })
    const invocation = {
      journal: {
        endpoint: {
          url: "https://journal.example/v1/stream/timer/pause/invocation-1",
        },
      },
    }

    const firstStarted = performance.now()
    const first = await runtimeWith(fakeFetch, client(timer, invocation).pause("first"))
    const firstElapsedMs = performance.now() - firstStarted
    const started = performance.now()
    const replayed = await runtimeWith(fakeFetch, client(timer, invocation).pause("first"))
    const replayElapsedMs = performance.now() - started

    expect(first).toBe("paused:first")
    expect(replayed).toBe("paused:first")
    expect(firstElapsedMs).toBeGreaterThanOrEqual(250)
    expect(replayElapsedMs).toBeLessThan(firstElapsedMs / 2)
  })

  it("fluent-firegrid-keystone.STATE.1 fluent-firegrid-keystone.STATE.2 fluent-firegrid-keystone.STATE.3 fluent-firegrid-keystone.STATE.4 persists free state access across invocation journals", async () => {
    type CounterState = {
      readonly count: number
      readonly secondary: string
    }

    const fakeFetch = makeMemoryDurableStreamsFetch()
    const counter = object({
      name: "counter",
      handlers: {
        add: (amount: number) =>
          gen(function* () {
            const s = state<CounterState>()
            const current = (yield* s.get("count")) ?? 0
            const next = current + amount
            s.set("count", next)
            return next
          }),
        current: (_: void) =>
          gen(function* () {
            return (yield* sharedState<CounterState>().get("count")) ?? 0
          }),
        keys: (_: void) =>
          gen(function* () {
            return yield* sharedState<CounterState>().keys()
          }),
        setSecondary: (value: string) =>
          gen(function* () {
            const s = state<CounterState>()
            s.set("secondary", value)
            return (yield* s.get("secondary")) ?? "missing"
          }),
        clearSecondary: (_: void) =>
          gen(function* () {
            state<CounterState>().clear("secondary")
          }),
        reset: (_: void) =>
          gen(function* () {
            state<CounterState>().clearAll()
          }),
      },
    })
    const statefulInvocation = (invocationId: string, key: string) => ({
      journal: {
        endpoint: {
          url: `https://journal.example/v1/stream/counter/invocation/${invocationId}`,
        },
      },
      state: {
        endpoint: {
          url: `https://journal.example/v1/stream/counter/state/${key}`,
        },
      },
    })

    await expect(runtimeWith(
      fakeFetch,
      client(counter, statefulInvocation("add-1", "alpha")).add(1),
    )).resolves.toBe(1)
    await expect(runtimeWith(
      fakeFetch,
      client(counter, statefulInvocation("add-2", "alpha")).add(2),
    )).resolves.toBe(3)
    await expect(runtimeWith(
      fakeFetch,
      client(counter, statefulInvocation("current", "alpha")).current(undefined),
    )).resolves.toBe(3)
    await expect(runtimeWith(
      fakeFetch,
      client(counter, statefulInvocation("other-current", "beta")).current(undefined),
    )).resolves.toBe(0)
    await expect(runtimeWith(
      fakeFetch,
      client(counter, statefulInvocation("secondary", "alpha")).setSecondary("hello"),
    )).resolves.toBe("hello")
    await expect(runtimeWith(
      fakeFetch,
      client(counter, statefulInvocation("keys", "alpha")).keys(undefined).pipe(
        Effect.map((keys) => keys.sort()),
      ),
    )).resolves.toEqual(["count", "secondary"])
    await runtimeWith(
      fakeFetch,
      client(counter, statefulInvocation("clear-secondary", "alpha")).clearSecondary(undefined),
    )
    await expect(runtimeWith(
      fakeFetch,
      client(counter, statefulInvocation("keys-after-clear", "alpha")).keys(undefined),
    )).resolves.toEqual(["count"])
    await runtimeWith(
      fakeFetch,
      client(counter, statefulInvocation("reset", "alpha")).reset(undefined),
    )
    await expect(runtimeWith(
      fakeFetch,
      client(counter, statefulInvocation("keys-after-reset", "alpha")).keys(undefined),
    )).resolves.toEqual([])
  })

  it("fluent-firegrid-keystone.DEFINITIONS.1 fluent-firegrid-keystone.DEFINITIONS.2 fluent-firegrid-keystone.DEFINITIONS.3 invokes a direct workflow definition", async () => {
    const fakeFetch = makeMemoryDurableStreamsFetch()
    const patchWorkflow = workflow({
      name: "patchWorkflow",
      handlers: {
        run: (title: string) =>
          gen(function* () {
            return yield* run(() => `opened:${title}`, {
              name: "open-patch",
            })
          }),
        status: (id: string) =>
          gen(function* () {
            return yield* run(() => `status:${id}:modeled`, {
              name: "read-status",
            })
          }),
      },
    })
    const invocation = {
      journal: {
        endpoint: {
          url: "https://journal.example/v1/stream/patch-workflow/run/invocation-1",
        },
      },
    }

    const runResult = await runtimeWith(fakeFetch, client(patchWorkflow, invocation).run("tf-n3qc"))
    const statusResult = await runtimeWith(
      fakeFetch,
      client(patchWorkflow, {
        journal: {
          endpoint: {
            url: "https://journal.example/v1/stream/patch-workflow/status/invocation-1",
          },
        },
      }).status("tf-n3qc"),
    )

    expect(patchWorkflow._kind).toBe("workflow")
    expect(runResult).toBe("opened:tf-n3qc")
    expect(statusResult).toBe("status:tf-n3qc:modeled")
  })
})
