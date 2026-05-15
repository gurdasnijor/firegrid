/**
 * Host-owned localhost MCP HTTP server smoke.
 *
 * The tests drive the real MCP SDK over
 * `/mcp/runtime-context/:contextId`, while Firegrid keeps protocol
 * handling inside `McpServer.layerHttp` +
 * `McpServer.registerToolkit(FiregridAgentToolkit)`.
 *
 * ACIDs:
 *  - firegrid-host-context-authority.MCP_CONTEXT_ROUTING.1
 *  - firegrid-host-context-authority.MCP_CONTEXT_ROUTING.2
 *  - firegrid-host-context-authority.MCP_CONTEXT_ROUTING.3
 *  - firegrid-host-context-authority.MCP_CONTEXT_ROUTING.4
 *  - firegrid-host-context-authority.VALIDATION.4
 */

import { DurableStreamTestServer } from "@durable-streams/server"
import { HttpServer } from "@effect/platform"
import {
  RuntimeControlPlaneTable,
  type HostId,
  hostOwnedStreamUrl,
  insertLocalRuntimeContext,
  local,
  makeHostStreamPrefix,
  normalizeRuntimeIntent,
} from "@firegrid/protocol/launch"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"
import { ConfigProvider, Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { firegridHostLayer } from "../../../../src/host.ts"
import {
  FiregridRuntimeHostWithWorkflowLive,
} from "../host/index.ts"
import { WorkflowEngineTable } from "../workflow-engine/DurableStreamsWorkflowEngine.ts"
import { FiregridMcpServerLayer, runtimeContextMcpPath } from "./mcp-host.ts"

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

const toolNames = [
  "execute",
  "schedule_me",
  "session_cancel",
  "session_close",
  "session_new",
  "session_prompt",
  "sleep",
  "wait_for",
] as const

const seedContext = (input: {
  readonly baseUrl: string
  readonly namespace: string
  readonly hostId: HostId
}) =>
  Effect.gen(function* () {
    const table = yield* RuntimeControlPlaneTable
    const contextId = `ctx_${crypto.randomUUID()}`
    yield* table.contexts.upsert({
      contextId,
      createdAt: new Date().toISOString(),
      runtime: normalizeRuntimeIntent(local.jsonl({
        argv: [process.execPath, "-e", "process.exit(0)"],
      })),
      host: {
        hostId: input.hostId,
        streamPrefix: makeHostStreamPrefix({
          namespace: input.namespace,
          hostId: input.hostId,
        }),
        boundAtMs: Date.now(),
      },
    })
    return contextId
  }).pipe(
    Effect.provide(RuntimeControlPlaneTable.layer({
      streamOptions: {
        url: `${input.baseUrl}/v1/stream/${input.namespace}.firegrid.runtime`,
        contentType: "application/json",
      },
    })),
    Effect.scoped,
  )

const queryHostWorkflowExecutions = (input: {
  readonly baseUrl: string
  readonly namespace: string
  readonly hostId: HostId
}) =>
  Effect.gen(function* () {
    const table = yield* WorkflowEngineTable
    const executions = yield* table.executions.query((coll) => coll.toArray)
    return executions.map((row) => row.executionId)
  }).pipe(
    Effect.provide(WorkflowEngineTable.layer({
      streamOptions: {
        url: hostOwnedStreamUrl({
          baseUrl: input.baseUrl,
          prefix: makeHostStreamPrefix({
            namespace: input.namespace,
            hostId: input.hostId,
          }),
          segment: "workflow",
        }),
        contentType: "application/json",
      },
    })),
    Effect.scoped,
  )

const mcpLayer = (input: {
  readonly baseUrl: string
  readonly namespace: string
  readonly hostId: HostId
}) =>
  FiregridMcpServerLayer({
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
  }).pipe(
    Layer.provideMerge(FiregridRuntimeHostWithWorkflowLive({
      durableStreamsBaseUrl: input.baseUrl,
      namespace: input.namespace,
      hostId: input.hostId,
      input: true,
    })),
  )

const contextUrl = (
  boundAddress: string,
  contextId: string,
) => new URL(`/mcp/runtime-context/${encodeURIComponent(contextId)}`, boundAddress)

const withSdkClient = <A>(
  url: URL,
  use: (client: Client) => Effect.Effect<A, unknown, never>,
) => {
  const transport = new StreamableHTTPClientTransport(url)
  const client = new Client(
    { name: "firegrid-host-context-smoke", version: "0.0.0" },
    {},
  )
  return Effect.acquireUseRelease(
    Effect.tryPromise(() =>
      client.connect(
        transport as unknown as Parameters<Client["connect"]>[0],
      )).pipe(Effect.as(client)),
    use,
    () =>
      Effect.tryPromise(() => client.close()).pipe(
        Effect.catchAll(() => Effect.void),
      ),
  )
}

const listToolNames = (client: Client) =>
  Effect.tryPromise(() => client.listTools()).pipe(
    Effect.map((listed) => listed.tools.map((tool) => tool.name).sort()),
  )

const assertInvalidParams = (error: unknown) => {
  expect(error).toBeInstanceOf(McpError)
  expect((error as McpError).code).toBe(ErrorCode.InvalidParams)
}

const captureCallToolRejection = (
  call: () => Promise<unknown>,
): Effect.Effect<unknown> =>
  Effect.promise(async () => {
    try {
      return { _tag: "Resolved", result: await call() } as const
    } catch (error) {
      return { _tag: "Rejected", error } as const
    }
  }).pipe(
    Effect.map((outcome) => {
      expect(outcome._tag).toBe("Rejected")
      return outcome._tag === "Rejected" ? outcome.error : outcome.result
    }),
  )

const hostConfigProvider = (input: {
  readonly namespace: string
  readonly mcpEnabled: boolean
}) => {
  if (!durableStreamBaseUrl) throw new Error("server not started")
  return ConfigProvider.fromMap(new Map([
    ["DURABLE_STREAMS_BASE_URL", durableStreamBaseUrl],
    ["FIREGRID_RUNTIME_NAMESPACE", input.namespace],
    ["FIREGRID_MCP_ENABLED", String(input.mcpEnabled)],
    ["FIREGRID_MCP_HOST", "127.0.0.1"],
    ["FIREGRID_MCP_PORT", "0"],
    ["FIREGRID_MCP_PATH", "/mcp"],
  ]))
}

describe("FiregridMcpServerLayer runtime-context routing", () => {
  it("firegrid-host-context-authority.MCP_CONTEXT_ROUTING.1 appends the runtime-context route to the configured MCP path", () => {
    expect(runtimeContextMcpPath("/mcp")).toBe("/mcp/runtime-context/:contextId")
    expect(runtimeContextMcpPath("/mcp/")).toBe("/mcp/runtime-context/:contextId")
    expect(runtimeContextMcpPath("*")).toBe("/runtime-context/:contextId")
  })

  it("firegrid-host-context-authority.MCP_CONTEXT_ROUTING.1 firegrid-host-context-authority.VALIDATION.4 drives tools/list and sleep for a local context through the real MCP SDK", async () => {
    if (!durableStreamBaseUrl) throw new Error("server not started")
    const namespace = `mcp-local-${crypto.randomUUID()}`
    const hostId = `host_A_${crypto.randomUUID()}` as HostId
    const contextId = await Effect.runPromise(
      seedContext({ baseUrl: durableStreamBaseUrl, namespace, hostId }),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const boundAddress = yield* HttpServer.addressFormattedWith(
            (addr) => Effect.succeed(addr),
          )
          expect(boundAddress.startsWith("http://127.0.0.1:")).toBe(true)
          yield* withSdkClient(contextUrl(boundAddress, contextId), (client) =>
            Effect.gen(function* () {
              expect(yield* listToolNames(client)).toEqual([...toolNames])
              const sleepResult = yield* Effect.tryPromise(() =>
                client.callTool({
                  name: "sleep",
                  arguments: { durationMs: 1 },
                }))
              expect(sleepResult.isError).toBeFalsy()
              expect(sleepResult.structuredContent).toEqual({ slept: true })
            }))
        }).pipe(
          Effect.provide(mcpLayer({
            baseUrl: durableStreamBaseUrl,
            namespace,
            hostId,
          })),
        ),
      ),
    )
  })

  it("firegrid-host-context-authority.MCP_CONTEXT_ROUTING.2 publishes the same canonical session-plane catalog across context paths", async () => {
    if (!durableStreamBaseUrl) throw new Error("server not started")
    const namespace = `mcp-catalog-${crypto.randomUUID()}`
    const hostId = `host_A_${crypto.randomUUID()}` as HostId
    const contextOne = await Effect.runPromise(
      seedContext({ baseUrl: durableStreamBaseUrl, namespace, hostId }),
    )
    const contextTwo = await Effect.runPromise(
      seedContext({ baseUrl: durableStreamBaseUrl, namespace, hostId }),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const boundAddress = yield* HttpServer.addressFormattedWith(
            (addr) => Effect.succeed(addr),
          )
          const first = yield* withSdkClient(
            contextUrl(boundAddress, contextOne),
            listToolNames,
          )
          const second = yield* withSdkClient(
            contextUrl(boundAddress, contextTwo),
            listToolNames,
          )
          expect(first).toEqual([...toolNames])
          expect(second).toEqual(first)
        }).pipe(
          Effect.provide(mcpLayer({
            baseUrl: durableStreamBaseUrl,
            namespace,
            hostId,
          })),
        ),
      ),
    )
  })

  it("firegrid-host-context-authority.MCP_CONTEXT_ROUTING.3 firegrid-host-context-authority.MCP_CONTEXT_ROUTING.4 returns an MCP tool error for a foreign-context tool call before workflow side effects", async () => {
    if (!durableStreamBaseUrl) throw new Error("server not started")
    const namespace = `mcp-foreign-${crypto.randomUUID()}`
    const hostA = `host_A_${crypto.randomUUID()}` as HostId
    const hostB = `host_B_${crypto.randomUUID()}` as HostId
    const foreignContext = await Effect.runPromise(
      seedContext({
        baseUrl: durableStreamBaseUrl,
        namespace,
        hostId: hostB,
      }),
    )

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const boundAddress = yield* HttpServer.addressFormattedWith(
            (addr) => Effect.succeed(addr),
          )
          return yield* withSdkClient(
            contextUrl(boundAddress, foreignContext),
            (client) =>
              Effect.gen(function* () {
                expect(yield* listToolNames(client)).toEqual([...toolNames])
                return yield* Effect.tryPromise(() =>
                  client.callTool({
                    name: "sleep",
                    arguments: { durationMs: 1 },
                  }))
              }),
          )
        }).pipe(
          Effect.provide(mcpLayer({
            baseUrl: durableStreamBaseUrl,
            namespace,
            hostId: hostA,
          })),
        ),
      ),
    )

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain("ContextNotLocal")

    const hostAExecutions = await Effect.runPromise(
      queryHostWorkflowExecutions({
        baseUrl: durableStreamBaseUrl,
        namespace,
        hostId: hostA,
      }),
    )
    expect(hostAExecutions).toEqual([])
  })

  it("firegrid-host-context-authority.MCP_CONTEXT_ROUTING.4 returns an MCP tool error for malformed route-based sleep input", async () => {
    if (!durableStreamBaseUrl) throw new Error("server not started")
    const namespace = `mcp-malformed-${crypto.randomUUID()}`
    const hostId = `host_A_${crypto.randomUUID()}` as HostId
    const contextId = await Effect.runPromise(
      seedContext({ baseUrl: durableStreamBaseUrl, namespace, hostId }),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const boundAddress = yield* HttpServer.addressFormattedWith(
            (addr) => Effect.succeed(addr),
          )
          yield* withSdkClient(contextUrl(boundAddress, contextId), (client) =>
            Effect.gen(function* () {
              const result = yield* Effect.tryPromise(() =>
                client.callTool({
                  name: "sleep",
                  arguments: { durationMs: "not-a-number" },
                }))
              expect(result.isError).toBe(true)
              expect(JSON.stringify(result)).toContain("sleep")
            }))
        }).pipe(
          Effect.provide(mcpLayer({
            baseUrl: durableStreamBaseUrl,
            namespace,
            hostId,
          })),
        ),
      ),
    )
  })

  it("firegrid-host-context-authority.MCP_CONTEXT_ROUTING.4 lets Effect AI reject unknown tools as InvalidParams", async () => {
    if (!durableStreamBaseUrl) throw new Error("server not started")
    const namespace = `mcp-unknown-${crypto.randomUUID()}`
    const hostId = `host_A_${crypto.randomUUID()}` as HostId
    const contextId = await Effect.runPromise(
      seedContext({ baseUrl: durableStreamBaseUrl, namespace, hostId }),
    )

    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const boundAddress = yield* HttpServer.addressFormattedWith(
            (addr) => Effect.succeed(addr),
          )
          return yield* withSdkClient(contextUrl(boundAddress, contextId), (client) =>
            captureCallToolRejection(() =>
              client.callTool({
                name: "definitely_not_a_firegrid_tool",
                arguments: {},
              })))
        }).pipe(
          Effect.provide(mcpLayer({
            baseUrl: durableStreamBaseUrl,
            namespace,
            hostId,
          })),
        ),
      ),
    )

    assertInvalidParams(error)
    expect(String(error)).toContain("definitely_not_a_firegrid_tool")
  })

  it("firegrid-host-context-authority.MCP_CONTEXT_ROUTING.1 leaves host composition buildable when MCP is disabled", async () => {
    await Effect.runPromise(
      Effect.scoped(Layer.build(firegridHostLayer)).pipe(
        Effect.withConfigProvider(hostConfigProvider({
          namespace: `host-disabled-${crypto.randomUUID()}`,
          mcpEnabled: false,
        })),
      ),
    )
  })

  it("firegrid-host-context-authority.MCP_CONTEXT_ROUTING.1 mounts the localhost MCP server from normal host composition when enabled", async () => {
    if (!durableStreamBaseUrl) throw new Error("server not started")
    const namespace = `host-enabled-${crypto.randomUUID()}`

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* insertLocalRuntimeContext(
            normalizeRuntimeIntent(local.jsonl({
              argv: [process.execPath, "-e", "process.exit(0)"],
            })),
            {
              contextId: `ctx_${crypto.randomUUID()}`,
              createdBy: "mcp-host-test",
            },
          )
          const address = yield* HttpServer.addressFormattedWith(
            (addr) => Effect.succeed(addr),
          )
          expect(address.startsWith("http://127.0.0.1:")).toBe(true)
          yield* withSdkClient(contextUrl(address, context.contextId), (client) =>
            Effect.gen(function* () {
              expect(yield* listToolNames(client)).toEqual([...toolNames])
            }))
        }).pipe(
          Effect.provide(firegridHostLayer),
        ),
      ).pipe(
        Effect.withConfigProvider(hostConfigProvider({
          namespace,
          mcpEnabled: true,
        })),
      ),
    )
  })

  it("firegrid-effect-ai-native-agents.MCP_TRANSPORT_COMPAT.1 firegrid-effect-ai-native-agents.VALIDATION.14 POST initialize returns an unwrapped single JSON-RPC object (not a JSON-RPC batch array) so strict clients can parse it", async () => {
    if (!durableStreamBaseUrl) throw new Error("server not started")
    const namespace = `mcp-transport-${crypto.randomUUID()}`
    const hostId = `host_A_${crypto.randomUUID()}` as HostId
    const contextId = await Effect.runPromise(
      seedContext({ baseUrl: durableStreamBaseUrl, namespace, hostId }),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const boundAddress = yield* HttpServer.addressFormattedWith(
            (addr) => Effect.succeed(addr),
          )
          const url = contextUrl(boundAddress, contextId)

          const requestBody = JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "transport-compat-probe", version: "0" },
            },
          })
          expect(requestBody.includes("\n")).toBe(false)
          const postResponse = yield* Effect.tryPromise(() =>
            fetch(url.toString(), {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
              },
              body: requestBody,
            }))
          expect(postResponse.status).toBe(200)
          expect(postResponse.headers.get("content-type")).toBe("application/json")
          const raw = (yield* Effect.tryPromise(() => postResponse.text())).trim()
          expect(raw.startsWith("{"), `expected a single JSON-RPC object on the wire, got: ${raw.slice(0, 200)}`).toBe(true)
          expect(raw.startsWith("["), `expected NOT a JSON-RPC batch array on the wire, got: ${raw.slice(0, 200)}`).toBe(false)
          const body = JSON.parse(raw) as {
            readonly jsonrpc: string
            readonly id: number
            readonly result: { readonly protocolVersion: string }
          }
          expect(body.jsonrpc).toBe("2.0")
          expect(body.id).toBe(1)
          expect(body.result.protocolVersion).toBe("2025-03-26")
        }).pipe(
          Effect.provide(mcpLayer({
            baseUrl: durableStreamBaseUrl,
            namespace,
            hostId,
          })),
        ),
      ),
    )
  })
})
