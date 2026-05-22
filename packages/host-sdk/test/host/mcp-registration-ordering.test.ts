/**
 * tf-x3sv — mechanism proof for the MCP toolkit registration ordering fix.
 *
 * The bug: a no-refresh MCP client (codex-acp) saw only a prefix of the
 * runtime-context toolset. Root cause is a build-ordering window in
 * `FiregridMcpServerLayer` — toolkit registration (a `scopedDiscard`
 * effect that pushes tools into `McpServer.tools`) was a *sibling* of
 * `HttpRouter.Default.serve()` inside a `mergeAll`, so the two built
 * concurrently. The MCP request handler is mounted on `HttpRouter.Default`
 * (`RpcServer.makeProtocolHttp` → `router.post`) and becomes reachable when
 * `serve()` installs the router as the HTTP app. If `serve()` wins the race,
 * a client can be handled a `tools/list` while `McpServer.tools` is still
 * being populated → a partial toolset.
 *
 * The fix makes registration a `Layer.provide` build-dependency of the
 * serving layers, giving a happens-before edge.
 *
 * An in-process `buildWithScope` test cannot reproduce the production
 * cross-process window directly (the bound address is only observable after
 * the whole layer finishes building, and registration is microseconds of
 * synchronous pushes). So this test models the exact composition with a
 * deliberately *slow* registration and a fixed port, and proves the
 * structural difference: the sibling shape serves requests before
 * registration completes; the dependency (fixed) shape does not.
 */
import { HttpRouter, HttpServerResponse } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { createServer } from "node:http"
import { describe, expect, it } from "vitest"

const REGISTRATION_DELAY = "400 millis"

// A route whose response reflects whether the (slow) "registration" has
// completed — read at request time, exactly like `tools/list` reads
// `server.tools` live.
const statusRoute = (state: { registered: boolean }) =>
  HttpRouter.Default.use(router =>
    router.get(
      "/status",
      Effect.sync(() =>
        HttpServerResponse.text(state.registered ? "registered" : "incomplete"),
      ),
    ))

const slowRegistration = (state: { registered: boolean }) =>
  Layer.scopedDiscard(
    Effect.gen(function*() {
      yield* Effect.sleep(REGISTRATION_DELAY)
      state.registered = true
    }),
  )

// `shape: "sibling"` = the pre-fix composition (registration concurrent with
// serve). `shape: "dependency"` = the fix (registration gates serve).
const makeLayer = (
  shape: "sibling" | "dependency",
  port: number,
  state: { registered: boolean },
) => {
  const registration = slowRegistration(state)
  const served = shape === "dependency"
    ? Layer.mergeAll(statusRoute(state), HttpRouter.Default.serve()).pipe(
      Layer.provide(registration),
    )
    : Layer.mergeAll(statusRoute(state), HttpRouter.Default.serve(), registration)
  return served.pipe(
    Layer.provideMerge(NodeHttpServer.layer(createServer, { port, host: "127.0.0.1" })),
  ) as Layer.Layer<never, unknown, never>
}

const runShape = async (
  shape: "sibling" | "dependency",
  port: number,
): Promise<ReadonlyArray<string>> => {
  const state = { registered: false }
  const observed: Array<string> = []
  let stop = false

  const poller = (async () => {
    while (!stop) {
      try {
        // The socket binds before `serve()` installs the app (NodeHttpServer
        // is the base dependency). In the dependency shape, requests during
        // the registration window have no app to answer them and hang — a
        // per-request timeout keeps the poller looping until `serve()` is up.
        const r = await fetch(`http://127.0.0.1:${port}/status`, {
          signal: AbortSignal.timeout(75),
        })
        const body = await r.text()
        if (r.status === 200 && (body === "registered" || body === "incomplete")) {
          observed.push(body)
        }
      } catch {
        // connection refused / no app yet / request timed out — keep polling
      }
    }
  })()

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const scope = yield* Effect.scope
        yield* Layer.buildWithScope(makeLayer(shape, port, state), scope)
        // let the poller land several requests after the server can serve
        yield* Effect.sleep("300 millis")
      }),
    ),
  )
  stop = true
  await poller
  return observed
}

describe("tf-x3sv MCP registration-before-serving ordering", () => {
  it("sibling shape (pre-fix) serves requests before registration completes — the leak", async () => {
    const observed = await runShape("sibling", 39621)
    // The pre-fix composition installs the HTTP app while registration is
    // still in flight, so an early client observes the incomplete state.
    expect(observed).toContain("incomplete")
  })

  it("dependency shape (fix) never serves a request before registration completes", async () => {
    const observed = await runShape("dependency", 39623)
    // The serving layers are gated behind registration: the app is not
    // installed until registration finishes, so no client can ever observe
    // the incomplete state. (We still see responses — the post-registration
    // ones — proving the server did come up.)
    expect(observed.length).toBeGreaterThan(0)
    expect(observed).not.toContain("incomplete")
    expect(observed.every(body => body === "registered")).toBe(true)
  })
})
