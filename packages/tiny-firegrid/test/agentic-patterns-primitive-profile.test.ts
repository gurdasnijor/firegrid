import { DurableStreamTestServer } from "@durable-streams/server"
import {
  Firegrid,
  FiregridConfig,
  FiregridLive,
  local,
} from "@firegrid/client-sdk/firegrid"
import {
  FiregridRuntimeContextMcpBaseUrl,
  runtimeContextMcpPath,
  type FiregridHost,
} from "@firegrid/host-sdk"
import { sessionContextIdForExternalKey } from "@firegrid/protocol/session-facade"
import { Effect, Layer, Option } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { agenticPatternsPrimitiveProfileHost } from "../src/simulations/agentic-patterns-primitive-profile/host.ts"
import {
  agenticPatternsExternalKey,
  agenticPatternsForbiddenToolNames,
  agenticPatternsPrimitiveToolNames,
} from "../src/simulations/agentic-patterns-primitive-profile/profile.ts"
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

const resultFromResponse = (response: unknown): Record<string, unknown> => {
  expect(isRecord(response)).toBe(true)
  if (!isRecord(response)) return {}
  expect(response.error).toBeUndefined()
  expect(isRecord(response.result)).toBe(true)
  return isRecord(response.result) ? response.result : {}
}

const toolNamesFromToolsList = (
  result: Record<string, unknown>,
): ReadonlyArray<string> => {
  expect(Array.isArray(result.tools)).toBe(true)
  const tools: ReadonlyArray<unknown> = Array.isArray(result.tools)
    ? result.tools
    : []
  return tools.flatMap(tool =>
    isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [],
  ).sort()
}

const profileLayer = (
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
    Layer.provideMerge(agenticPatternsPrimitiveProfileHost(hostEnv)),
  ) as Layer.Layer<
    Firegrid | FiregridHost | FiregridRuntimeContextMcpBaseUrl,
    unknown,
    never
  >

describe("agentic-patterns primitive profile", () => {
  it("agentic-patterns-primitive-profile.ERGONOMIC_LAUNCH.1 agentic-patterns-primitive-profile.ERGONOMIC_LAUNCH.2 agentic-patterns-primitive-profile.ERGONOMIC_LAUNCH.3 agentic-patterns-primitive-profile.LOCKED_TOOL_SURFACE.1 agentic-patterns-primitive-profile.LOCKED_TOOL_SURFACE.2 agentic-patterns-primitive-profile.LOCKED_TOOL_SURFACE.3 agentic-patterns-primitive-profile.SUBSTRATE_BOUNDARY.1 lists only the locked runtime-context MCP primitives", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const runId = `primitive-profile-${crypto.randomUUID()}`
    const namespace = `tiny-firegrid-${runId}`
    const externalKey = agenticPatternsExternalKey(runId)
    const expectedContextId = sessionContextIdForExternalKey(externalKey)
    const hostEnv: TinyFiregridHostEnv = {
      simulationId: "agentic-patterns-primitive-profile",
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
          createdBy: "tf-t47b.agentic-patterns-primitive-profile",
          runtime: local.jsonl({
            argv: [process.execPath, "--version"],
            agentProtocol: "stdio-jsonl",
            runtimeContextMcp: { enabled: true },
          }),
        })
        expect(session.contextId).toBe(expectedContextId)
        yield* session.prompt({
          payload: "tf-t47b primitive profile smoke",
          idempotencyKey: `tf-t47b:${runId}:initial`,
        })
        yield* session.start()

        const mcpBaseUrl = yield* FiregridRuntimeContextMcpBaseUrl
        const mcpBase = yield* mcpBaseUrl.get
        expect(Option.isSome(mcpBase)).toBe(true)
        if (Option.isNone(mcpBase)) return

        const runtimeContextMcpUrl = new URL(
          runtimeContextMcpPath(mcpBase.value.basePath).replace(
            ":contextId",
            encodeURIComponent(session.contextId),
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
                name: "tf-t47b-agentic-patterns-primitive-profile",
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
        const result = resultFromResponse(toolsList)
        expect(toolNamesFromToolsList(result)).toEqual(
          [...agenticPatternsPrimitiveToolNames].sort(),
        )
        for (const name of agenticPatternsForbiddenToolNames) {
          expect(toolNamesFromToolsList(result)).not.toContain(name)
        }
        expect(JSON.stringify(result)).not.toMatch(
          /DurableTable|RuntimeControlPlaneTable|RuntimeOutputTable|WorkflowEngine|RuntimeContextWorkflow|hostSession|streamUrl/,
        )
      }).pipe(
        Effect.provide(profileLayer(hostEnv)),
        Effect.scoped,
      ),
    )
  })
})
