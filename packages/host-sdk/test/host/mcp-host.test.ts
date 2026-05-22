import { DurableStreamTestServer } from "@durable-streams/server"
import { HttpServer } from "@effect/platform"
import { Context, Effect, Layer, Schema, Tracer, type Exit } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  FiregridLocalHostLive,
} from "../../src/host/index.ts"
import {
  FiregridMcpServerLayer,
} from "../../src/host/mcp-host.ts"
import {
  FiregridAgentToolkit,
} from "../../src/agent-tools/index.ts"

// Minimal projection of the JSON-RPC `tools/list` response — only the tool
// names matter for this assertion.
const ToolsListResponse = Schema.Struct({
  result: Schema.optional(Schema.Struct({
    tools: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
  })),
})

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
          const publishSpan = capturedSpans.find(span =>
            span.name === "firegrid.mcp.publish_runtime_context_base")

          expect(publishSpan).toBeDefined()
          expect(publishSpan?.attributes["firegrid.mcp.bound_address"]).toBe(address)
          expect(publishSpan?.attributes["firegrid.mcp.path"]).toBe("/mcp")

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

  // tf-x3sv: a no-refresh MCP client (e.g. codex-acp) snapshots `tools/list`
  // once and ignores `notifications/tools/list_changed`. The first
  // `tools/list` it receives MUST already carry the complete canonical
  // runtime-context toolset; correctness must not depend on a later
  // `list_changed` refresh.
  it("tf-x3sv first tools/list returns the complete canonical toolset without any list_changed refresh", async () => {
    const capturedSpans: Array<CapturedSpan> = []
    const contextId = `ctx_${crypto.randomUUID()}`

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const scope = yield* Effect.scope
          const context = yield* Layer.buildWithScope(mcpHostLayer(capturedSpans), scope)
          const server = Context.get(context, HttpServer.HttpServer)
          const address = HttpServer.formatAddress(server.address)
          const url = `${address}/mcp/runtime-context/${contextId}`

          // A single, unrefreshed JSON-RPC `tools/list` — exactly what a
          // no-refresh client issues after connecting. No `list_changed`
          // subscription, no second fetch.
          const response = yield* Effect.promise(() =>
            fetch(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
              },
              body:
                "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}",
            }))
          const bodyText = yield* Effect.promise(() => response.text())

          expect(response.status).toBe(200)
          const payload = yield* Schema.decodeUnknown(Schema.parseJson(ToolsListResponse))(bodyText)
          const listedNames = (payload.result?.tools ?? [])
            .map(tool => tool.name)
            .sort()

          const expectedNames = Object.keys(FiregridAgentToolkit.tools).sort()
          // The full canonical set — sleep/wait_for/send/wait_for_any/
          // session_* and the rest — present on the very first list.
          expect(listedNames).toEqual(expectedNames)
          for (
            const canonical of [
              "sleep",
              "wait_for",
              "wait_for_any",
              "send",
              "session_new",
              "session_prompt",
              "session_cancel",
              "session_close",
              "schedule_me",
              "execute",
              "call",
            ]
          ) {
            expect(listedNames).toContain(canonical)
          }
        }),
      ),
    )
  })
})
