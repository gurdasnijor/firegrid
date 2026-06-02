// tf-r06u.28 slice 4 — acceptance against the REAL bound HTTP MCP endpoint.
//
// Stands up the unified `FiregridMcpServerLayer` on a loopback NodeHttpServer
// and drives it over the wire with a standard MCP JSON-RPC handshake
// (initialize → notifications/initialized → tools/list → tools/call). Proves:
//
//   1. tf-x3sv (register-before-serve): the FIRST `tools/list` after
//      initialize returns the COMPLETE toolset — no `list_changed` needed
//      (full profile = 11 tools; primitive profile = the 4 locked primitives).
//   2. `sleep` executes end-to-end through the real HTTP route and returns
//      `{ slept: true }`.
//   3. tf-rgdt verdict (serializer): a single non-batch JSON-RPC request gets
//      a single-object response (not a `[response]` array). If this assertion
//      fails, the deferred MCP_TRANSPORT_COMPAT.1 single-response serializer
//      must be re-added for strict single-message clients (codex-acp).
//
// This is the deferred-customization verdict point. We do NOT pre-emptively
// re-add the serializer / OAuth probes — the round-trip below decides.
//
// (The full client-session path — base-URL late-binding + x-firegrid-channels
// metadata + wait_for over a real channel — depends on tf-rgdt's deferred
// pieces and a wire-path slice; out of scope here.)

import { HttpServer } from "@effect/platform"
import { DurableStreamTestServer } from "@durable-streams/server"
import type { RuntimeContext } from "@firegrid/protocol/launch"
import { Effect, Layer, Option } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DurableStreamsWorkflowEngine } from "../../src/engine/durable-streams-workflow-engine.ts"
import { ContextResolverTag } from "../../src/unified/codec-adapter.ts"
import { FiregridMcpServerLayer } from "../../src/unified/mcp-host/mcp-host.ts"
import { FiregridRuntimeContextMcpBaseUrlLive } from "../../src/unified/mcp-host/runtime-context-mcp-base-url.ts"
import { ToolDispatchLive } from "../../src/unified/mcp-host/tool-dispatch.ts"

let server: DurableStreamTestServer | undefined
let baseUrl: string | undefined

beforeEach(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  baseUrl = await server.start()
})

afterEach(async () => {
  ;(server as unknown as {
    server?: { closeAllConnections?: () => void }
  } | undefined)?.server?.closeAllConnections?.()
  await server?.stop()
  server = undefined
  baseUrl = undefined
})

// ── JSON-RPC helpers ──────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

interface JsonRpcRequest {
  readonly jsonrpc: "2.0"
  readonly id?: number
  readonly method: string
  readonly params?: unknown
}

const postJsonRpcRaw = async (url: string, payload: JsonRpcRequest): Promise<unknown> => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  })
  expect(response.ok).toBe(true)
  const text = await response.text()
  return text.length === 0 ? undefined : (JSON.parse(text) as unknown)
}

// A single non-batch JSON-RPC request must get a single-object response, not
// a `[response]` array. Returns whether the body was array-wrapped — the
// tf-rgdt single-response-serializer verdict.
const unwrapSingle = (
  body: unknown,
): { readonly message: Record<string, unknown>; readonly wasArrayWrapped: boolean } => {
  if (Array.isArray(body)) {
    expect(body.length).toBe(1)
    const first: unknown = body[0]
    expect(isRecord(first)).toBe(true)
    return { message: isRecord(first) ? first : {}, wasArrayWrapped: true }
  }
  expect(isRecord(body)).toBe(true)
  return { message: isRecord(body) ? body : {}, wasArrayWrapped: false }
}

const resultFromMessage = (message: Record<string, unknown>): unknown => {
  expect(message.error).toBeUndefined()
  expect(message.result).toBeDefined()
  return message.result
}

const toolNamesFromToolsList = (result: unknown): ReadonlyArray<string> => {
  expect(isRecord(result)).toBe(true)
  if (!isRecord(result)) return []
  const tools: ReadonlyArray<unknown> = Array.isArray(result.tools) ? result.tools : []
  return tools
    .flatMap((tool) => (isRecord(tool) && typeof tool.name === "string" ? [tool.name] : []))
    .sort()
}

const toolPayloadFromResult = (result: unknown): Record<string, unknown> => {
  expect(isRecord(result)).toBe(true)
  if (!isRecord(result)) return {}
  if (isRecord(result.structuredContent)) return result.structuredContent
  const content: ReadonlyArray<unknown> = Array.isArray(result.content) ? result.content : []
  const first = content[0]
  if (isRecord(first) && typeof first.text === "string") {
    const parsed: unknown = JSON.parse(first.text)
    return isRecord(parsed) ? parsed : {}
  }
  return result
}

// ── Layer composition ─────────────────────────────────────────────────────

// Route-context resolver stub: any contextId resolves to a present (non-undefined)
// RuntimeContext. The route resolver only requires presence; the handler reads
// no RuntimeContext fields (sleep is context-agnostic).
const contextResolverStub = Layer.succeed(ContextResolverTag, {
  resolve: (contextId: string) =>
    Effect.succeed(Option.some({ contextId } as unknown as RuntimeContext)),
})

const mcpServerLayer = (streamUrl: string, toolProfile?: "full" | "primitive") =>
  FiregridMcpServerLayer({
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
    ...(toolProfile === undefined ? {} : { toolProfile }),
  }).pipe(
    Layer.provide(
      Layer.merge(ToolDispatchLive, contextResolverStub).pipe(
        Layer.provide(DurableStreamsWorkflowEngine.layer({ streamUrl })),
      ),
    ),
    Layer.provide(FiregridRuntimeContextMcpBaseUrlLive),
  )

const FULL_TOOLS = [
  "call",
  "execute",
  "send",
  "session_cancel",
  "session_close",
  "session_new",
  "session_prompt",
  "sleep",
  "wait_any",
  "wait_for",
  "wait_until",
].sort()

const PRIMITIVE_TOOLS = ["call", "send", "wait_any", "wait_for"].sort()

const runAgainstServer = <A>(
  streamUrl: string,
  toolProfile: "full" | "primitive" | undefined,
  body: (mcpUrl: string) => Promise<A>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      HttpServer.addressFormattedWith((origin) =>
        Effect.promise(() => body(`${origin}/mcp/runtime-context/ctx-accept`)),
      ).pipe(Effect.provide(mcpServerLayer(streamUrl, toolProfile))),
    ) as Effect.Effect<A, never, never>,
  )

const initialize = async (mcpUrl: string): Promise<void> => {
  await postJsonRpcRaw(mcpUrl, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "tf-r06u.28-acceptance", version: "0.0.0" },
    },
  })
  await postJsonRpcRaw(mcpUrl, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  })
}

describe("mcp-host: real bound HTTP endpoint (slice 4 acceptance)", () => {
  it("tf-x3sv: first tools/list returns the complete full toolset, and sleep executes e2e", async () => {
    const streamUrl = `${baseUrl}/v1/stream/mcp-accept-full-${crypto.randomUUID()}`
    const observed = await runAgainstServer(streamUrl, undefined, async (mcpUrl) => {
      await initialize(mcpUrl)
      const listBody = await postJsonRpcRaw(mcpUrl, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      })
      const list = unwrapSingle(listBody)
      const names = toolNamesFromToolsList(resultFromMessage(list.message))

      const sleepBody = await postJsonRpcRaw(mcpUrl, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "sleep", arguments: { durationMs: 1 } },
      })
      const sleep = unwrapSingle(sleepBody)
      const sleepPayload = toolPayloadFromResult(resultFromMessage(sleep.message))
      return { names, sleepPayload, wasArrayWrapped: list.wasArrayWrapped }
    })

    // tf-x3sv: complete toolset on the FIRST tools/list (no list_changed).
    expect(observed.names).toEqual(FULL_TOOLS)
    // sleep e2e over the real HTTP route.
    expect(observed.sleepPayload).toMatchObject({ slept: true })
    // tf-rgdt verdict (RESOLVED): the default layerJsonRpc array-wrapped a
    // single response (`[response]`) — strict single-message clients break on
    // that — so mcp-host.ts re-added the MCP_TRANSPORT_COMPAT.1 single-response
    // serializer (evidence-based, not pre-emptive). With it, a single non-batch
    // request gets a single-object response.
    expect(observed.wasArrayWrapped).toBe(false)
  })

  it("primitive profile lists only the 4 locked primitives", async () => {
    const streamUrl = `${baseUrl}/v1/stream/mcp-accept-prim-${crypto.randomUUID()}`
    const names = await runAgainstServer(streamUrl, "primitive", async (mcpUrl) => {
      await initialize(mcpUrl)
      const listBody = await postJsonRpcRaw(mcpUrl, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      })
      return toolNamesFromToolsList(resultFromMessage(unwrapSingle(listBody).message))
    })
    expect(names).toEqual(PRIMITIVE_TOOLS)
  })
})
