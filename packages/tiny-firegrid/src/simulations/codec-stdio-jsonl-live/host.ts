import {
  FiregridEnvBindingsFromEnv,
  FiregridLocalHostLive,
  FiregridLocalProcessFromEnv,
} from "@firegrid/host-sdk"
import { Effect, Layer } from "effect"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { TinyFiregridHostEnv } from "../../types.ts"

const portSeed = new Uint16Array(1)
globalThis.crypto.getRandomValues(portSeed)

const probeHost = "127.0.0.1"
const probePath = "/mcp"
export const probeToolName = "stdio_probe"
export const probeResultMarker = "FIREGRID_STDIO_JSONL_PROBE_TOOL_CALLED"
export const codecStdioJsonlProbePort = 41_000 + ((portSeed[0] ?? 0) % 18_000)
export const codecStdioJsonlProbeUrl =
  `http://${probeHost}:${codecStdioJsonlProbePort}${probePath}`

interface ProbeState {
  readonly methods: Array<string>
  readonly toolCalls: Array<unknown>
}

const probeState: ProbeState = {
  methods: [],
  toolCalls: [],
}

export const codecStdioJsonlProbeSnapshot = (): ProbeState => ({
  methods: [...probeState.methods],
  toolCalls: [...probeState.toolCalls],
})

interface JsonRpcRequest {
  readonly id?: unknown
  readonly method?: unknown
  readonly params?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const readBody = (
  request: IncomingMessage,
): Effect.Effect<string, Error> =>
  Effect.async<string, Error>((resume) => {
    let body = ""
    request.setEncoding("utf8")
    request.on("data", chunk => {
      body += String(chunk)
    })
    request.on("end", () => resume(Effect.succeed(body)))
    request.on("error", error => resume(Effect.fail(error)))
  })

const sendJson = (
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): Effect.Effect<void> =>
  Effect.sync(() => {
    response.statusCode = statusCode
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify(payload))
  })

const sendNoContent = (response: ServerResponse): Effect.Effect<void> =>
  Effect.sync(() => {
    response.statusCode = 204
    response.end()
  })

const jsonRpcResult = (id: unknown, result: unknown) => ({
  jsonrpc: "2.0",
  id,
  result,
})

const jsonRpcError = (
  id: unknown,
  code: number,
  message: string,
) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
})

const toolInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    phrase: {
      type: "string",
      description: "Any short phrase to echo in the probe result.",
    },
  },
} as const

const handleJsonRpc = (
  request: JsonRpcRequest,
): Effect.Effect<unknown> =>
  Effect.gen(function*() {
    const id = request.id
    const method = typeof request.method === "string" ? request.method : ""
    probeState.methods.push(method)
    yield* Effect.annotateCurrentSpan({
      "firegrid.codec_stdio_jsonl_live.probe.method": method,
    })
    switch (method) {
      case "initialize":
        return jsonRpcResult(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "tiny-firegrid.codec-stdio-jsonl-live",
            version: "0.0.0",
          },
        })
      case "notifications/initialized":
        return undefined
      case "ping":
        return jsonRpcResult(id, {})
      case "tools/list":
        return jsonRpcResult(id, {
          tools: [
            {
              name: probeToolName,
              description:
                "Return a deterministic marker proving Codex consumed this MCP server.",
              inputSchema: toolInputSchema,
            },
          ],
        })
      case "tools/call": {
        const params = request.params
        probeState.toolCalls.push(params)
        if (!isRecord(params) || params.name !== probeToolName) {
          return jsonRpcError(id, -32602, "unknown tool")
        }
        return jsonRpcResult(id, {
          content: [
            {
              type: "text",
              text: `${probeResultMarker} ${JSON.stringify(params.arguments ?? {})}`,
            },
          ],
          structuredContent: {
            marker: probeResultMarker,
            arguments: params.arguments ?? {},
          },
          isError: false,
        })
      }
      default:
        return jsonRpcError(id, -32601, `method not found: ${method}`)
    }
  }).pipe(
    Effect.withSpan("firegrid.codec_stdio_jsonl_live.probe.request", {
      kind: "server",
    }),
  )

const ProbeMcpServerLayer = Layer.scopedDiscard(
  Effect.gen(function*() {
    probeState.methods.length = 0
    probeState.toolCalls.length = 0
    const server = createServer((request, response) => {
      const run = Effect.gen(function*() {
        if (request.method !== "POST" || request.url?.split("?")[0] !== probePath) {
          return yield* sendJson(response, 404, { error: "not found" })
        }
        const body = yield* readBody(request)
        const parsed = JSON.parse(body) as unknown
        if (!isRecord(parsed)) {
          return yield* sendJson(response, 400, jsonRpcError(null, -32600, "invalid request"))
        }
        const result = yield* handleJsonRpc(parsed)
        if (result === undefined) return yield* sendNoContent(response)
        return yield* sendJson(response, 200, result)
      }).pipe(
        Effect.catchAllCause(cause =>
          sendJson(response, 200, jsonRpcError(null, -32603, String(cause))),
        ),
      )
      Effect.runFork(run)
    })
    yield* Effect.acquireRelease(
      Effect.async<void, Error>((resume) => {
        server.once("error", error => resume(Effect.fail(error)))
        server.listen(codecStdioJsonlProbePort, probeHost, () => resume(Effect.void))
      }).pipe(Effect.orDie),
      () =>
        Effect.async<void>((resume) => {
          server.close(() => resume(Effect.void))
        }),
    )
  }).pipe(
    Effect.withSpan("firegrid.codec_stdio_jsonl_live.probe.layer", {
      kind: "server",
      attributes: {
        "firegrid.codec_stdio_jsonl_live.probe.url": codecStdioJsonlProbeUrl,
        "firegrid.codec_stdio_jsonl_live.probe.tool": probeToolName,
      },
    }),
  ),
)

export const codecStdioJsonlLiveHost = (
  env: TinyFiregridHostEnv,
) => {
  const host = FiregridLocalHostLive({
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
    input: true,
  }).pipe(
    Layer.provide(FiregridLocalProcessFromEnv(env.processEnv)),
    Layer.provide(FiregridEnvBindingsFromEnv({
      processEnv: env.processEnv,
      allow: [["OPENAI_API_KEY", "OPENAI_API_KEY"]],
    })),
  )
  return Layer.mergeAll(host, ProbeMcpServerLayer)
}
