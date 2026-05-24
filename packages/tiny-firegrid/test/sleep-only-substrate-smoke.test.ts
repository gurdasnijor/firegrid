import { DurableStreamTestServer } from "@durable-streams/server"
import {
  Firegrid,
  FiregridConfig,
  FiregridLive,
  local,
} from "@firegrid/client-sdk/firegrid"
import type { FiregridHost } from "@firegrid/runtime/composition/host-live"
import {
  FiregridRuntimeContextMcpBaseUrl,
} from "@firegrid/runtime/composition/runtime-context-mcp-base-url"
import {
  runtimeContextMcpPath,
} from "@firegrid/runtime/producers/codecs/mcp"
import { sessionContextIdForExternalKey } from "@firegrid/protocol/session-facade"
import { Effect, Layer, Option } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { darkFactoryHost } from "../src/simulations/dark-factory/host.ts"
import type { TinyFiregridHostEnv } from "../src/types.ts"

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

interface JsonRpcRequest {
  readonly jsonrpc: "2.0"
  readonly id?: number
  readonly method: string
  readonly params?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const postJsonRpc = async (
  url: string,
  payload: JsonRpcRequest,
): Promise<unknown> => {
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
  return text.length === 0 ? undefined : JSON.parse(text) as unknown
}

const resultFromResponse = (response: unknown): unknown => {
  expect(isRecord(response)).toBe(true)
  if (!isRecord(response)) {
    return undefined
  }
  expect(response.error).toBeUndefined()
  expect(response.result).toBeDefined()
  return response.result
}

const schemaExtensionsFromToolsList = (result: unknown): ReadonlyArray<unknown> => {
  expect(isRecord(result)).toBe(true)
  if (!isRecord(result)) {
    return []
  }
  expect(Array.isArray(result.tools)).toBe(true)
  const tools: ReadonlyArray<unknown> = Array.isArray(result.tools)
    ? result.tools
    : []
  const waitForTool = tools.find(tool =>
    isRecord(tool) && tool.name === "wait_for",
  )
  expect(isRecord(waitForTool)).toBe(true)
  if (!isRecord(waitForTool)) {
    return []
  }
  expect(isRecord(waitForTool.inputSchema)).toBe(true)
  if (!isRecord(waitForTool.inputSchema)) {
    return []
  }
  const metadata = waitForTool.inputSchema["x-firegrid-channels"]
  expect(Array.isArray(metadata)).toBe(true)
  return Array.isArray(metadata) ? metadata : []
}

const toolPayloadFromResult = (result: unknown): Record<string, unknown> => {
  expect(isRecord(result)).toBe(true)
  if (!isRecord(result)) {
    return {}
  }
  if (isRecord(result.structuredContent)) {
    return result.structuredContent
  }
  const content: ReadonlyArray<unknown> = Array.isArray(result.content)
    ? result.content
    : []
  const firstContent = content[0]
  if (isRecord(firstContent) && typeof firstContent.text === "string") {
    const parsed: unknown = JSON.parse(firstContent.text)
    return isRecord(parsed) ? parsed : {}
  }
  return result
}

const smokeLayer = (
  hostEnv: TinyFiregridHostEnv,
): Layer.Layer<
  Firegrid | FiregridHost | FiregridRuntimeContextMcpBaseUrl,
  unknown,
  never
> =>
  FiregridLive.pipe(
    Layer.provide(
      Layer.succeed(FiregridConfig, {
        durableStreamsBaseUrl: hostEnv.durableStreamsBaseUrl,
        namespace: hostEnv.namespace,
      }),
    ),
    Layer.provideMerge(darkFactoryHost(hostEnv)),
  ) as Layer.Layer<
    Firegrid | FiregridHost | FiregridRuntimeContextMcpBaseUrl,
    unknown,
    never
  >

describe("dark-factory sleep + wait_for substrate smoke", () => {
  it("firegrid-agent-body-plan.MCP_CHANNEL_METADATA.1 firegrid-workflow-driven-runtime.PHASE_7_MCP_HOST_SERVER.6 firegrid-workflow-driven-runtime.PHASE_6_AGENT_TOOLS.10 exposes channel metadata and executes sleep plus wait_for through the runtime-context MCP route", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const runId = `sleep-smoke-${crypto.randomUUID()}`
    const namespace = `tiny-firegrid-${runId}`
    const externalKey = {
      source: "tiny-firegrid.sleep-smoke",
      id: runId,
    }
    const expectedContextId = sessionContextIdForExternalKey(externalKey)
    const hostEnv: TinyFiregridHostEnv = {
      simulationId: "sleep-only-substrate-smoke",
      runId,
      namespace,
      durableStreamsBaseUrl: baseUrl,
      processEnv: {},
      stopSignal: {
        complete: Effect.void,
      },
    }

    await Effect.runPromise(
      Effect.gen(function*() {
        const firegrid = yield* Firegrid
        const session = yield* firegrid.sessions.createOrLoad({
          externalKey,
          createdBy: "tf-rjta.sleep-only-substrate-smoke",
          runtime: local.jsonl({
            argv: [process.execPath, "--version"],
            agentProtocol: "stdio-jsonl",
            runtimeContextMcp: { enabled: true },
          }),
        })
        expect(session.contextId).toBe(expectedContextId)
        expect(session.contextId).not.toBe("dark-factory")

        const snapshot = yield* session.snapshot()
        expect(snapshot.contextId).toBe(expectedContextId)
        expect(snapshot.context).toBeDefined()
        if (snapshot.context === undefined) {
          return
        }

        const mcpBaseUrl = yield* FiregridRuntimeContextMcpBaseUrl
        const mcpBase = yield* mcpBaseUrl.get
        expect(Option.isSome(mcpBase)).toBe(true)
        if (Option.isNone(mcpBase)) {
          return
        }
        const runtimeContextMcpUrl = new URL(
          runtimeContextMcpPath(mcpBase.value.basePath).replace(
            ":contextId",
            encodeURIComponent(snapshot.contextId),
          ),
          mcpBase.value.address,
        ).toString()

        yield* Effect.promise(() =>
          postJsonRpc(runtimeContextMcpUrl, {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: {
                name: "tf-rjta-sleep-smoke",
                version: "0.0.0",
              },
            },
          }))
        yield* Effect.promise(() =>
          postJsonRpc(runtimeContextMcpUrl, {
            jsonrpc: "2.0",
            method: "notifications/initialized",
            params: {},
          }))
        const toolsList = yield* Effect.promise(() =>
          postJsonRpc(runtimeContextMcpUrl, {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: {},
          }))
        const channelMetadata = schemaExtensionsFromToolsList(
          resultFromResponse(toolsList),
        )
        const names = channelMetadata.map(entry =>
          isRecord(entry) ? entry.name : undefined,
        )
        expect(names).toEqual(expect.arrayContaining([
          "factory.events",
          "event.plan.ready",
          "dm.operator",
          "notification.operator",
          "approval.operator",
        ]))

        const sleepResult = yield* Effect.promise(() =>
          postJsonRpc(runtimeContextMcpUrl, {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: {
              name: "sleep",
              arguments: {
                durationMs: 1,
              },
            },
          }))
        expect(toolPayloadFromResult(resultFromResponse(sleepResult))).toMatchObject({
          slept: true,
        })

        const waitForResult = yield* Effect.promise(() =>
          postJsonRpc(runtimeContextMcpUrl, {
            jsonrpc: "2.0",
            id: 4,
            method: "tools/call",
            params: {
              name: "wait_for",
              arguments: {
                channel: "factory.events",
                match: {
                  externalEventKey: `trigger-${runId}`,
                },
                timeoutMs: 5_000,
              },
            },
          }))
        expect(toolPayloadFromResult(resultFromResponse(waitForResult))).toMatchObject({
          matched: true,
          event: {
            externalEventKey: `trigger-${runId}`,
            eventType: "factory.trigger.accepted",
          },
        })
      }).pipe(
        Effect.provide(smokeLayer(hostEnv)),
        Effect.scoped,
      ),
    )
  })
})
