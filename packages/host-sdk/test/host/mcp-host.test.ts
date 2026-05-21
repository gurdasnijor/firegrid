import { DurableStreamTestServer } from "@durable-streams/server"
import { HttpServer } from "@effect/platform"
import { Context, Effect, Layer, Tracer, type Exit } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  FiregridLocalHostLive,
} from "../../src/host/index.ts"
import {
  FiregridMcpServerLayer,
} from "../../src/host/mcp-host.ts"

let server: DurableStreamTestServer | undefined
let baseUrl: string | undefined

beforeEach(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  baseUrl = await server.start()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  baseUrl = undefined
})

interface CapturedSpan {
  readonly name: string
  readonly attributes: Record<string, unknown>
  exitTag?: Exit.Exit<unknown, unknown>["_tag"]
}

const capturingTracerLayer = (
  capturedSpans: Array<CapturedSpan>,
): Layer.Layer<never> => {
  const tracer: Tracer.Tracer = {
    [Tracer.TracerTypeId]: Tracer.TracerTypeId,
    span: (name, parent, context, links, startTime, kind) => {
      const attributes: Record<string, unknown> = {}
      const captured: CapturedSpan = { name, attributes }
      capturedSpans.push(captured)
      let status: Tracer.SpanStatus = { _tag: "Started", startTime }
      const span: Tracer.Span = {
        _tag: "Span",
        name,
        spanId: `mcp-${crypto.randomUUID()}`,
        traceId: "mcp-oauth-discovery-test",
        parent,
        context,
        get status() {
          return status
        },
        attributes: new Map<string, unknown>(),
        links,
        sampled: true,
        kind,
        end: (endTime, exit) => {
          status = { _tag: "Ended", startTime, endTime, exit }
          captured.exitTag = exit._tag
        },
        attribute: (key, value) => {
          attributes[key] = value
        },
        event: () => {},
        addLinks: () => {},
      }
      return span
    },
    context: f => f(),
  }
  return Layer.setTracer(tracer)
}

const mcpHostLayer = (
  capturedSpans: Array<CapturedSpan>,
): Layer.Layer<HttpServer.HttpServer, unknown, never> => {
  if (baseUrl === undefined) throw new Error("server not started")
  const namespace = `mcp-oauth-discovery-${crypto.randomUUID()}`
  const layer = FiregridMcpServerLayer({
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
  }).pipe(
    Layer.provideMerge(FiregridLocalHostLive({
      durableStreamsBaseUrl: baseUrl,
      namespace,
      input: true,
      controlRequestReconciler: false,
    })),
    Layer.provideMerge(capturingTracerLayer(capturedSpans)),
  )
  return layer as Layer.Layer<HttpServer.HttpServer, unknown, never>
}

describe("Firegrid MCP HTTP host", () => {
  it("firegrid-workflow-driven-runtime.PHASE_7_MCP_HOST_SERVER.11 firegrid-workflow-driven-runtime.VALIDATION.11 returns non-error 404 spans for OAuth discovery probes", async () => {
    const capturedSpans: Array<CapturedSpan> = []
    const contextId = `ctx_${crypto.randomUUID()}`
    const probePaths = [
      "/.well-known/oauth-authorization-server",
      `/mcp/runtime-context/${contextId}/.well-known/oauth-authorization-server`,
      `/.well-known/oauth-authorization-server/mcp/runtime-context/${contextId}`,
    ]

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const scope = yield* Effect.scope
          const context = yield* Layer.buildWithScope(mcpHostLayer(capturedSpans), scope)
          const server = Context.get(context, HttpServer.HttpServer)
          const address = HttpServer.formatAddress(server.address)

          yield* Effect.forEach(
            probePaths,
            probePath =>
              Effect.gen(function*() {
                const response = yield* Effect.promise(() =>
                  fetch(`${address}${probePath}`),
                )
                yield* Effect.promise(() => response.arrayBuffer())

                expect(response.status).toBe(404)
                const probeSpan = capturedSpans.find(span =>
                  span.attributes["url.path"] === probePath)
                expect(probeSpan).toBeDefined()
                expect(probeSpan?.attributes["http.response.status_code"]).toBe(404)
                expect(probeSpan?.exitTag).toBe("Success")
              }),
            { discard: true },
          )
        }),
      ),
    )
  })
})
