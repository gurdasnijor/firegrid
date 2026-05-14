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
  hostOwnedStreamUrl,
  local,
  makeHostStreamPrefix,
  normalizeRuntimeIntent,
  type HostId,
} from "@firegrid/protocol/launch"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ConfigProvider, Effect, Either, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { firegridHostLayer } from "../../../../src/host.ts"
import {
  FiregridRuntimeHostWithWorkflowLive,
} from "../runtime-host/index.ts"
import { WorkflowEngineTable } from "../workflow-engine/DurableStreamsWorkflowEngine.ts"
import { FiregridMcpServerLayer } from "./mcp-host.ts"

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
  "sleep",
  "spawn",
  "spawn_all",
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

  it("firegrid-host-context-authority.MCP_CONTEXT_ROUTING.2 publishes the same canonical six-tool catalog across context paths", async () => {
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

  it("firegrid-host-context-authority.MCP_CONTEXT_ROUTING.3 firegrid-host-context-authority.MCP_CONTEXT_ROUTING.4 rejects a foreign-context tool call before workflow side effects", async () => {
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
                return yield* Effect.either(
                  Effect.tryPromise(() =>
                    client.callTool({
                      name: "sleep",
                      arguments: { durationMs: 1 },
                    })),
                )
              }),
          )
        }).pipe(
          Effect.provide(mcpLayer({
            baseUrl: durableStreamBaseUrl,
            namespace,
            hostId: hostA,
          })),
        ) as Effect.Effect<Either.Either<unknown, unknown>, unknown, never>,
      ),
    )

    if (Either.isRight(result)) {
      expect(result.right).toMatchObject({ isError: true })
      expect(JSON.stringify(result.right)).toContain("ContextNotLocal")
    } else {
      expect(String(result.left)).toContain("ContextNotLocal")
    }

    const hostAExecutions = await Effect.runPromise(
      queryHostWorkflowExecutions({
        baseUrl: durableStreamBaseUrl,
        namespace,
        hostId: hostA,
      }),
    )
    expect(hostAExecutions).toEqual([])
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
    const address = await Effect.runPromise(
      Effect.scoped(
        HttpServer.addressFormattedWith((addr) => Effect.succeed(addr)).pipe(
          Effect.provide(firegridHostLayer),
        ),
      ).pipe(
        Effect.withConfigProvider(hostConfigProvider({
          namespace: `host-enabled-${crypto.randomUUID()}`,
          mcpEnabled: true,
        })),
      ),
    )

    expect(address.startsWith("http://127.0.0.1:")).toBe(true)
  })
})
