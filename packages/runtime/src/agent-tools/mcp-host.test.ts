/**
 * V1 smoke for the host-owned localhost MCP HTTP server.
 *
 * Spins up `FiregridMcpServerLayer` over a Node HTTP server bound to
 * `127.0.0.1` on an OS-chosen port, then drives MCP `initialize`,
 * `tools/list`, and `tools/call` through `fetch` against the bound
 * URL. The fetch-based variant proves the V1 acceptance surface
 * end-to-end without standing up the official MCP SDK transport (the
 * real SDK client smoke is owned by a parallel worker; see
 * coordination notes alongside this PR).
 *
 * What this proves:
 *   - The bridge composes through `McpServer.registerToolkit(
 *     FiregridAgentToolkit)` and `McpServer.layerHttp` (no custom
 *     JSON-RPC stack, no wrapper toolkit, no manual `tools/list` or
 *     `tools/call` handler).
 *   - `tools/list` returns exactly the six canonical
 *     `FiregridAgentToolkit` tools.
 *   - `sleep` flows through `FiregridAgentToolkitLayer`,
 *     `ToolCallWorkflow.execute`, `toolUseToEffect`, and
 *     `DurableClock.sleep`.
 *   - Malformed input maps to `CallToolResult.isError === true`
 *     inside an HTTP 200 response — no HTTP 500, no custom protocol
 *     error.
 *   - Unknown tool name maps to a standard JSON-RPC `-32602` error
 *     code inside an HTTP 200 response — Effect AI's library default
 *     for unknown tools per MCP semantics — also not an HTTP 500 and
 *     not a Firegrid-custom protocol error.
 *
 * Spec: docs/proposals/SDD_FIREGRID_AGENT_TOOLS_MCP_BRIDGE.md §"V1: Host-Owned Localhost MCP Server"
 * ACIDs: firegrid-workflow-driven-runtime.PHASE_7_MCP_HOST_SERVER.1..7
 */

import { DurableStreamTestServer } from "@durable-streams/server"
import { HttpServer } from "@effect/platform"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DurableStreamsWorkflowEngine } from "../workflow-engine/DurableStreamsWorkflowEngine.ts"
import { type AgentToolHostService } from "./tool-host.ts"
import { toolExecutionFailed } from "./tool-error.ts"
import { FiregridMcpServerLayer } from "./mcp-host.ts"

/**
 * Test-local `AgentToolHostService`. V1 production callers must supply
 * a real host capability — silently no-op'ing `appendScheduledPrompt`
 * would let `schedule_me` return `{ scheduled: true }` while the
 * scheduled prompt is dropped. This test host fails explicitly for
 * any tool that should not be exercised by the V1 smoke; the smoke
 * itself only drives `sleep`, malformed `sleep`, and unknown tool.
 */
const testAgentToolHost: AgentToolHostService = {
  spawnChildContext: ({ toolUseId }) =>
    Effect.fail(
      toolExecutionFailed(
        toolUseId,
        "spawn",
        "spawn is not exercised by the V1 host-local MCP smoke",
      ),
    ),
  spawnChildContexts: ({ toolUseId }) =>
    Effect.fail(
      toolExecutionFailed(
        toolUseId,
        "spawn_all",
        "spawn_all is not exercised by the V1 host-local MCP smoke",
      ),
    ),
  executeSandboxTool: ({ toolUseId }) =>
    Effect.fail(
      toolExecutionFailed(
        toolUseId,
        "execute",
        "execute is not exercised by the V1 host-local MCP smoke",
      ),
    ),
  appendScheduledPrompt: ({ inputId }) =>
    Effect.fail(
      toolExecutionFailed(
        inputId,
        "schedule_me",
        "schedule_me is not exercised by the V1 host-local MCP smoke; if you reach this, the scheduled-input workflow body was invoked but the test host did not record the prompt",
      ),
    ),
}

let durableStreamServer: DurableStreamTestServer | undefined
let durableStreamBaseUrl: string | undefined

beforeEach(async () => {
  durableStreamServer = new DurableStreamTestServer({
    port: 0,
    host: "127.0.0.1",
  })
  durableStreamBaseUrl = await durableStreamServer.start()
})

afterEach(async () => {
  await durableStreamServer?.stop()
  durableStreamServer = undefined
  durableStreamBaseUrl = undefined
})

interface FetchedRpc {
  readonly status: number
  readonly contentType: string | null
  readonly body: string
}

describe("FiregridMcpServerLayer V1 smoke", () => {
  it(
    "binds loopback HTTP and drives initialize + tools/list + sleep + malformed + unknown via JSON-RPC fetch",
    { timeout: 20_000 },
    async () => {
      if (!durableStreamBaseUrl) throw new Error("server not started")
      const streamId = crypto.randomUUID()
      const workflowStreamUrl =
        `${durableStreamBaseUrl}/v1/stream/mcp-host-smoke-workflow-${streamId}`
      const agentToolsStreamUrl =
        `${durableStreamBaseUrl}/v1/stream/mcp-host-smoke-tools-${streamId}`
      // `Layer.provideMerge` keeps `WorkflowEngineTable` in the
      // composed Layer's output so the MCP handler and workflow engine
      // share the same durable scope.
      const smokeLayer = FiregridMcpServerLayer({
        host: "127.0.0.1",
        port: 0,
        path: "/mcp",
        contextId: "ctx-mcp-host-smoke",
        agentToolsStreamUrl,
        agentToolHost: testAgentToolHost,
      }).pipe(
        Layer.provideMerge(DurableStreamsWorkflowEngine.layer({
          streamUrl: workflowStreamUrl,
        })),
      )

      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const boundAddress = yield* HttpServer.addressFormattedWith(
              (addr) => Effect.succeed(addr),
            )
            const url = new URL("/mcp", boundAddress)
            const post = (
              body: unknown,
              timeout: `${number} seconds`,
            ): Effect.Effect<FetchedRpc, unknown, never> =>
              Effect.tryPromise(() =>
                fetch(url, {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    accept: "application/json, text/event-stream",
                  },
                  body: JSON.stringify(body),
                }).then(async (response): Promise<FetchedRpc> => ({
                  status: response.status,
                  contentType: response.headers.get("content-type"),
                  body: await response.text(),
                })),
              ).pipe(Effect.timeout(timeout))

            const init = yield* post(
              {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                  protocolVersion: "2025-06-18",
                  capabilities: {},
                  clientInfo: {
                    name: "firegrid-smoke",
                    version: "0.0.0",
                  },
                },
              },
              "5 seconds",
            )
            const list = yield* post(
              {
                jsonrpc: "2.0",
                id: 2,
                method: "tools/list",
                params: {},
              },
              "5 seconds",
            )
            const sleep = yield* post(
              {
                jsonrpc: "2.0",
                id: 3,
                method: "tools/call",
                params: {
                  name: "sleep",
                  arguments: { durationMs: 1 },
                },
              },
              "10 seconds",
            )
            const malformed = yield* post(
              {
                jsonrpc: "2.0",
                id: 4,
                method: "tools/call",
                params: {
                  name: "sleep",
                  arguments: { durationMs: "not-a-number" },
                },
              },
              "5 seconds",
            )
            const unknown = yield* post(
              {
                jsonrpc: "2.0",
                id: 5,
                method: "tools/call",
                params: {
                  name: "definitely_not_a_tool",
                  arguments: {},
                },
              },
              "5 seconds",
            )
            return {
              boundAddress,
              init,
              list,
              sleep,
              malformed,
              unknown,
            }
          }).pipe(
            Effect.provide(smokeLayer),
          ) as Effect.Effect<
            {
              boundAddress: string
              init: FetchedRpc
              list: FetchedRpc
              sleep: FetchedRpc
              malformed: FetchedRpc
              unknown: FetchedRpc
            },
            unknown,
            never
          >,
        ),
      )

      // PHASE_7_MCP_HOST_SERVER.2: bound only to loopback.
      expect(result.boundAddress.startsWith("http://127.0.0.1:")).toBe(true)

      // PHASE_7_MCP_HOST_SERVER.3: MCP `initialize` returns the
      // server's identity, capabilities, and protocol version.
      expect(result.init.status).toBe(200)
      expect(result.init.body).toContain('"name":"firegrid.agent-tools"')
      expect(result.init.body).toContain('"protocolVersion"')

      // PHASE_7_MCP_HOST_SERVER.6: `tools/list` returns exactly the
      // six canonical FiregridAgentToolkit tools.
      expect(result.list.status).toBe(200)
      for (const name of [
        "sleep",
        "wait_for",
        "spawn",
        "spawn_all",
        "schedule_me",
        "execute",
      ]) {
        expect(result.list.body).toContain(`"name":"${name}"`)
      }

      // PHASE_7_MCP_HOST_SERVER.6: `sleep` flows through the toolkit
      // and `DurableClock.sleep`, returning a structured-content
      // success.
      expect(result.sleep.status).toBe(200)
      expect(result.sleep.body).toContain('"structuredContent":{"slept":true}')
      expect(result.sleep.body).toContain('"isError":false')

      // PHASE_7_MCP_HOST_SERVER.6: malformed input is mapped to
      // `CallToolResult.isError === true` inside an HTTP 200 success
      // — not an HTTP 500 and not a custom protocol error.
      expect(result.malformed.status).toBe(200)
      expect(result.malformed.body).toContain('"isError":true')
      expect(result.malformed.body).toContain("Failed to decode tool call")

      // PHASE_7_MCP_HOST_SERVER.6 (library default): unknown tool
      // names map to a standard JSON-RPC `-32602` error response
      // (Effect AI's MCP library default for `tools/call` with a
      // name not in the registered toolkit). Still HTTP 200, no
      // Firegrid-custom protocol error, no wrapper toolkit.
      expect(result.unknown.status).toBe(200)
      expect(result.unknown.body).toContain('"code":-32602')
      expect(result.unknown.body).toContain("not found")
    },
  )

  it(
    "firegrid-workflow-driven-runtime.PHASE_7_MCP_HOST_SERVER.6 drives tools/list and sleep through the real Streamable HTTP MCP SDK client",
    { timeout: 30_000 },
    async () => {
      if (!durableStreamBaseUrl) throw new Error("server not started")
      const streamId = crypto.randomUUID()
      const workflowStreamUrl =
        `${durableStreamBaseUrl}/v1/stream/mcp-host-sdk-workflow-${streamId}`
      const agentToolsStreamUrl =
        `${durableStreamBaseUrl}/v1/stream/mcp-host-sdk-tools-${streamId}`
      const smokeLayer = FiregridMcpServerLayer({
        host: "127.0.0.1",
        port: 0,
        path: "/mcp",
        contextId: "ctx-mcp-host-sdk-smoke",
        agentToolsStreamUrl,
        agentToolHost: testAgentToolHost,
      }).pipe(
        Layer.provideMerge(DurableStreamsWorkflowEngine.layer({
          streamUrl: workflowStreamUrl,
        })),
      )

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const boundAddress = yield* HttpServer.addressFormattedWith(
              (addr) => Effect.succeed(addr),
            )
            const transport = new StreamableHTTPClientTransport(
              new URL("/mcp", boundAddress),
            )
            const client = new Client(
              { name: "firegrid-host-smoke", version: "0.0.0" },
              {},
            )

            yield* Effect.acquireUseRelease(
              Effect.tryPromise(() =>
                client.connect(
                  transport as unknown as Parameters<Client["connect"]>[0],
                ),
              ),
              () =>
                Effect.gen(function* () {
                  const listed = yield* Effect.tryPromise(() => client.listTools())
                  expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
                    "execute",
                    "schedule_me",
                    "sleep",
                    "spawn",
                    "spawn_all",
                    "wait_for",
                  ])

                  const sleepResult = yield* Effect.tryPromise(() =>
                    client.callTool({
                      name: "sleep",
                      arguments: { durationMs: 1 },
                    }),
                  )
                  expect(sleepResult.isError).toBeFalsy()
                  expect(sleepResult.structuredContent).toEqual({ slept: true })

                  const malformed = yield* Effect.tryPromise(() =>
                    client.callTool({
                      name: "sleep",
                      arguments: { durationMs: "not-a-number" },
                    }),
                  )
                  expect(malformed.isError).toBe(true)
                  expect(malformed.structuredContent).toMatchObject({
                    _tag: "MalformedOutput",
                  })

                  const unknown = yield* Effect.tryPromise({
                    try: () =>
                      client.callTool({
                        name: "definitely_not_a_tool",
                        arguments: {},
                      }),
                    catch: error => error,
                  }).pipe(Effect.flip)
                  expect(unknown).toBeInstanceOf(McpError)
                  expect((unknown as McpError).code).toBe(ErrorCode.InvalidParams)
                  expect((unknown as Error).message).toContain(
                    "Tool 'definitely_not_a_tool' not found",
                  )
                }),
              () =>
                Effect.tryPromise(() => client.close()).pipe(
                  Effect.catchAll(() => Effect.void),
                ),
            )
          }).pipe(
            Effect.provide(smokeLayer),
          ) as Effect.Effect<void, unknown, never>,
        ),
      )
    },
  )
})
