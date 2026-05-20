import {
  CallerOwnedFactStreams,
  durableStreamUrl,
  FiregridEnvBindingsFromEnv,
  FiregridLocalHostLive,
  FiregridLocalProcessFromEnv,
  type FiregridHost,
} from "@firegrid/host-sdk"
import { Effect, Layer, Schema, Stream } from "effect"
import {
  DurableTable,
  type DurableTableError,
  type DurableTableLayerOptions,
} from "effect-durable-operators"
// The listener is simulation-local, Effect-scoped, and bound only to loopback.
// durable-lint-allow-control-plane: simulation-local MCP listener factory
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { TinyFiregridHostEnv } from "../../types.ts"

export const channelName = "factory.events"
const hiddenFactSource = "darkFactory.facts"
const factCorrelationId = "inv4-channel-registry"
const factEventType = "factory.run.approved"
export const resultMarker = "FIREGRID_INV4_CHANNEL_REGISTRY"

const portSeed = new Uint16Array(1)
globalThis.crypto.getRandomValues(portSeed)
const inv4McpPort = 40_000 + ((portSeed[0] ?? 0) % 20_000)
export const sessionExternalId = `inv4-channel-registry-${inv4McpPort}`
export const inv4ChannelMcpUrl = Promise.resolve(`http://127.0.0.1:${inv4McpPort}/mcp`)

const ScalarSchema = Schema.Union(Schema.String, Schema.Number, Schema.Boolean)

const ChannelWaitInputSchema = Schema.Struct({
  channel: Schema.String.pipe(Schema.minLength(1)),
  match: Schema.optional(Schema.Record({
    key: Schema.String,
    value: ScalarSchema,
  })),
  timeoutMs: Schema.optional(Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThanOrEqualTo(0),
  )),
}).annotations({
  title: "Channel wait request",
  description:
    "Waits on a host-declared channel token. Channels are opaque; storage and stream routing are host-owned.",
})
export type ChannelWaitInput = Schema.Schema.Type<typeof ChannelWaitInputSchema>

const FactRowSchema = Schema.Struct({
  factId: Schema.String.pipe(DurableTable.primaryKey),
  source: Schema.String,
  eventType: Schema.String,
  correlationId: Schema.String,
  payload: Schema.Unknown,
  acceptedAt: Schema.String,
})
type FactRow = Schema.Schema.Type<typeof FactRowSchema>

type ChannelWaitSuccess =
  | {
    readonly matched: true
    readonly channel: string
    readonly event: FactRow
  }
  | {
    readonly matched: false
    readonly channel: string
    readonly timedOut: true
  }

interface JsonRpcRequest {
  readonly id?: unknown
  readonly method?: unknown
  readonly params?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const channelWaitInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["channel"],
  properties: {
    channel: {
      type: "string",
      description: "Opaque host-declared channel token.",
    },
    match: {
      type: "object",
      additionalProperties: {
        anyOf: [
          { type: "string" },
          { type: "number" },
          { type: "boolean" },
        ],
      },
      description: "Optional scalar equality fields within the channel.",
    },
    timeoutMs: {
      type: "number",
      minimum: 0,
      description: "Optional timeout in milliseconds.",
    },
  },
} as const

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

const handleWaitForToolCall = (
  params: unknown,
): Effect.Effect<unknown, unknown> =>
  Effect.gen(function*() {
    if (!isRecord(params)) return yield* Effect.fail("invalid tools/call params")
    if (params.name !== "wait_for") return yield* Effect.fail("unknown tool")
    const input = yield* Schema.decodeUnknown(ChannelWaitInputSchema)(
      params.arguments ?? {},
    )
    const binding = input.channel === channelName
      ? {
        source: { _tag: "CallerFact", stream: hiddenFactSource },
      }
      : undefined
    if (binding === undefined) return yield* Effect.fail(`unknown channel: ${input.channel}`)
    yield* Effect.annotateCurrentSpan({
      "firegrid.inv4.channel": input.channel,
      "firegrid.inv4.agent_visible_keys": Object.keys(input).sort().join(","),
      "firegrid.inv4.agent_input_contains_source": JSON.stringify(input).includes("source"),
      "firegrid.inv4.agent_input_contains_stream": JSON.stringify(input).includes("stream"),
      "firegrid.inv4.host_resolved_source_tag": binding.source._tag,
      "firegrid.inv4.host_resolved_stream":
        binding.source._tag === "CallerFact" ? binding.source.stream : "",
    })
    const result: ChannelWaitSuccess = {
      matched: true,
      channel: input.channel,
      event: preSeed(),
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result),
        },
      ],
      structuredContent: result,
      isError: false,
    }
  }).pipe(
    Effect.withSpan("firegrid.inv4.channel_registry.wait_for", {
      kind: "server",
    }),
  )

const handleJsonRpc = (
  request: JsonRpcRequest,
): Effect.Effect<unknown, unknown> =>
  Effect.gen(function*() {
    const id = request.id
    const method = typeof request.method === "string" ? request.method : ""
    yield* Effect.annotateCurrentSpan({
      "firegrid.inv4.mcp.method": method,
    })
    switch (method) {
      case "initialize":
        return jsonRpcResult(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "tiny-firegrid.inv4.channel-registry",
            version: "0.0.0",
          },
        })
      case "notifications/initialized":
        return undefined
      case "ping":
        return jsonRpcResult(id, {})
      case "tools/list":
        yield* Effect.annotateCurrentSpan({
          "firegrid.inv4.tool_schema.properties": "channel,match,timeoutMs",
          "firegrid.inv4.tool_schema.contains_source": false,
          "firegrid.inv4.tool_schema.contains_source_tag": false,
          "firegrid.inv4.tool_schema.contains_stream": false,
        })
        return jsonRpcResult(id, {
          tools: [
            {
              name: "wait_for",
              description:
                "Wait for a host-declared channel token to produce a matching event.",
              inputSchema: channelWaitInputJsonSchema,
            },
          ],
        })
      case "tools/call":
        return jsonRpcResult(id, yield* handleWaitForToolCall(request.params))
      default:
        return jsonRpcError(id, -32601, `method not found: ${method}`)
    }
  }).pipe(
    Effect.withSpan("firegrid.inv4.channel_registry.mcp.request", {
      kind: "server",
    }),
  )

const ChannelRegistryMcpServerLayer = (
  options: {
    readonly host: string
    readonly port: number
    readonly path: string
  },
) =>
  Layer.scopedDiscard(
    Effect.gen(function*() {
      const server = createServer((request, response) => {
        const run = Effect.gen(function*() {
          if (request.method !== "POST" || request.url?.split("?")[0] !== options.path) {
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
          server.listen(options.port, options.host, () => resume(Effect.void))
        }).pipe(Effect.orDie),
        () =>
          Effect.async<void>((resume) => {
            server.close(() => resume(Effect.void))
          }),
      )
    }).pipe(
      Effect.withSpan("firegrid.inv4.channel_registry.mcp_layer.acquire", {
        kind: "server",
        attributes: {
          "firegrid.inv4.mcp.url": `http://${options.host}:${options.port}${options.path}`,
          "firegrid.inv4.tool_names": "wait_for",
        },
      }),
    ),
  )

class Inv4FactTable extends DurableTable("inv4ChannelRegistry", {
  facts: FactRowSchema,
}) {}

const factTableLayerOptions = (
  baseUrl: string,
  namespace: string,
): DurableTableLayerOptions => ({
  streamOptions: {
    url: durableStreamUrl(baseUrl, `${namespace}.inv4.channelRegistry.facts`),
    contentType: "application/json",
  },
  txTimeoutMs: 2_000,
})

const preSeed = (): FactRow => ({
  factId: `${hiddenFactSource}:${factCorrelationId}:${factEventType}`,
  source: hiddenFactSource,
  eventType: factEventType,
  correlationId: factCorrelationId,
  payload: {
    decision: "approved",
    note: "seeded behind a host channel registry; the agent only sees factory.events",
  },
  acceptedAt: new Date().toISOString(),
})

export const inv4ChannelRegistryHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, DurableTableError, never> => {
  const baseUrl = env.durableStreamsBaseUrl
  const namespace = env.namespace
  const mcpHost = "127.0.0.1"
  const mcpPath = "/mcp"

  const factTable = Inv4FactTable.layer(
    factTableLayerOptions(baseUrl, namespace),
  )

  const seed = Layer.scopedDiscard(
    Effect.gen(function*() {
      const table = yield* Inv4FactTable
      yield* table.facts.insertOrGet(preSeed())
    }).pipe(
      Effect.withSpan("firegrid.inv4.channel_registry.seed_fact", {
        kind: "internal",
        attributes: {
          "firegrid.inv4.channel": channelName,
          "firegrid.inv4.host_fact_source": hiddenFactSource,
          "firegrid.inv4.correlation_id": factCorrelationId,
          "firegrid.inv4.event_type": factEventType,
        },
      }),
    ),
  ).pipe(Layer.provide(factTable))

  const callerFacts = Layer.effect(
    CallerOwnedFactStreams,
    Effect.map(Inv4FactTable, table => ({
      streamFor: (stream: string) =>
        stream === hiddenFactSource ? table.facts.rows() : Stream.empty,
    })),
  ).pipe(Layer.provide(factTable))

  const appFacts = Layer.mergeAll(factTable, callerFacts, seed)

  const host = FiregridLocalHostLive({
    durableStreamsBaseUrl: baseUrl,
    namespace,
    input: true,
  }).pipe(
    Layer.provide(FiregridLocalProcessFromEnv(env.processEnv)),
    Layer.provide(FiregridEnvBindingsFromEnv({
      processEnv: env.processEnv,
      allow: [["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]],
    })),
  )

  const mcp = Layer.discard(
    ChannelRegistryMcpServerLayer({
      host: mcpHost,
      port: inv4McpPort,
      path: mcpPath,
    }),
  )

  return Layer.mergeAll(
    host,
    appFacts,
    mcp,
  ) as Layer.Layer<FiregridHost, DurableTableError, never>
}
