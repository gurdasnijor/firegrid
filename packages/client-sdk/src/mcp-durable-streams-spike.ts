import { FetchHttpClient } from "@effect/platform"
import type { HttpClient } from "@effect/platform"
import { McpSchema } from "@effect/ai"
import { RpcClient, RpcClientError } from "@effect/rpc"
import type { RpcGroup, RpcMessage } from "@effect/rpc"
import { DurableStream } from "effect-durable-streams"
import { Config, Effect, Exit, Layer, Option, Schema, Stream } from "effect"
import {
  Firegrid,
  FiregridConfig,
  local,
} from "./firegrid.ts"

const durableStreamUrl = (
  baseUrl: string,
  streamName: string,
): string => `${baseUrl.replace(/\/+$/, "")}/v1/stream/${encodeURIComponent(streamName)}`

interface DurableMcpTransportSpec {
  readonly durableStreamsBaseUrl: string
  readonly namespace: string
  readonly transportId: string
}

const streamName = (
  spec: DurableMcpTransportSpec,
  direction: "client-to-server" | "server-to-client",
): string => `${spec.namespace}.tiny-firegrid.mcp-durable.${spec.transportId}.${direction}`

const streamFor = (
  spec: DurableMcpTransportSpec,
  direction: "client-to-server" | "server-to-client",
) =>
  DurableStream.define({
    endpoint: {
      url: durableStreamUrl(spec.durableStreamsBaseUrl, streamName(spec, direction)),
    },
    schema: Schema.Unknown,
  })

const ensureStreams = (
  spec: DurableMcpTransportSpec,
) =>
  Effect.all([
    streamFor(spec, "client-to-server").create({ contentType: "application/json" }).pipe(
      Effect.ignore,
    ),
    streamFor(spec, "server-to-client").create({ contentType: "application/json" }).pipe(
      Effect.ignore,
    ),
  ])

const provideFetch = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, HttpClient.HttpClient>> =>
  effect.pipe(Effect.provide(FetchHttpClient.layer))

const rpcClientError = (
  message: string,
  cause: unknown,
): RpcClientError.RpcClientError =>
  new RpcClientError.RpcClientError({
    reason: "Protocol",
    message,
    cause,
  })

const layerProtocolDurableStreamsClient = (
  spec: DurableMcpTransportSpec,
): Layer.Layer<RpcClient.Protocol> =>
  Layer.scoped(RpcClient.Protocol, Effect.gen(function*() {
    yield* provideFetch(ensureStreams(spec)).pipe(Effect.orDie)
    const clientToServer = streamFor(spec, "client-to-server")
    const serverToClient = streamFor(spec, "server-to-client")

    return RpcClient.Protocol.of({
      run: (onResponse) =>
        provideFetch(serverToClient.read({ live: "long-poll" }).pipe(
          Stream.runForEach(message =>
            onResponse(message as RpcMessage.FromServerEncoded).pipe(
              Effect.withSpan("tiny_firegrid.mcp_durable.client.receive", {
                attributes: {
                  "firegrid.mcp_durable.transport_id": spec.transportId,
                  "firegrid.mcp_durable.message_tag": (message as { readonly _tag?: string })._tag ?? "",
                },
              }),
            )),
          Effect.forever,
          Effect.orDie,
        )),
      send: request =>
        provideFetch(clientToServer.append(request)).pipe(
          Effect.withSpan("tiny_firegrid.mcp_durable.client.send", {
            attributes: {
              "firegrid.mcp_durable.transport_id": spec.transportId,
              "firegrid.mcp_durable.message_tag": request._tag,
            },
          }),
          Effect.mapError(cause =>
            rpcClientError("Failed to append MCP request to Durable Streams", cause)),
        ),
      supportsAck: false,
      supportsTransferables: false,
    })
  }))

const claudeAcpArgv = [
  "npx",
  "-y",
  "@agentclientprotocol/claude-agent-acp@0.36.1",
] as const

const parentExternalKey = {
  source: "tiny-firegrid",
  id: "mcp-durable-parent",
} as const

const parentContextId =
  `session:${parentExternalKey.source}:${parentExternalKey.id}` as const

const anthropicKeyConfig = Config.redacted("ANTHROPIC_API_KEY").pipe(
  Config.option,
)

const marker = "MCP_DURABLE_STREAMS_GATEWAY_ACK"
const initialChildPrompt = [
  "This is a Firegrid MCP-over-durable-streams gateway probe.",
  `Reply with exactly this marker on its own line: ${marker}`,
  "Do not call tools for this first response.",
].join("\n")

const permissionProbePrompt = [
  "Attempt to create a file named /tmp/firegrid-mcp-durable-permission-probe.txt containing MCP_DURABLE_PERMISSION.",
  "If the harness asks for permission, wait for the permission response.",
].join("\n")

const callTool = (
  client: RpcClient.RpcClient<
    RpcGroup.Rpcs<typeof McpSchema.ClientRpcs>,
    RpcClientError.RpcClientError
  >,
  name: string,
  args: Record<string, unknown>,
) =>
  client["tools/call"]({
    name,
    arguments: args,
  }).pipe(
    Effect.withSpan("tiny_firegrid.mcp_durable.client.call_tool", {
      kind: "client",
      attributes: {
        "firegrid.mcp.tool_name": name,
      },
    }),
  )

const toolStructuredContent = (result: McpSchema.CallToolResult): unknown =>
  result.structuredContent

const childSessionIdFrom = (value: unknown): string | undefined => {
  if (
    typeof value === "object" &&
    value !== null &&
    "session" in value &&
    typeof value.session === "object" &&
    value.session !== null &&
    "sessionId" in value.session &&
    typeof value.session.sessionId === "string"
  ) {
    return value.session.sessionId
  }
  return undefined
}

const objectRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined

const matchedObservationFrom = (value: unknown): Record<string, unknown> | undefined => {
  const outer = objectRecord(value)
  if (outer?.matched !== true) return undefined
  return objectRecord(outer.event)
}

const outputSequenceFrom = (value: unknown): number | undefined => {
  const observation = matchedObservationFrom(value)
  return typeof observation?.sequence === "number" ? observation.sequence : undefined
}

const outputEventTagFrom = (value: unknown): string | undefined => {
  const event = objectRecord(matchedObservationFrom(value)?.event)
  return typeof event?._tag === "string" ? event._tag : undefined
}

const permissionRequestSummary = (value: unknown): {
  readonly matched: boolean
  readonly permissionRequestId?: string
} => {
  const observation = matchedObservationFrom(value)
  if (typeof observation?.permissionRequestId === "string") {
    return {
      matched: true,
      permissionRequestId: observation.permissionRequestId,
    }
  }
  return { matched: false }
}

const exitTag = (exit: Exit.Exit<unknown, unknown>): string =>
  Exit.isSuccess(exit) ? "Success" : "Failure"

export const runMcpDurableStreamsGatewaySpike: Effect.Effect<
  void,
  unknown,
  Firegrid | FiregridConfig
> =
  Effect.scoped(Effect.gen(function*() {
    const anthropicKey = yield* anthropicKeyConfig
    if (Option.isNone(anthropicKey)) {
      yield* Effect.annotateCurrentSpan({
        "firegrid.mcp_durable.status": "blocked",
        "firegrid.mcp_durable.blocked_reason": "ANTHROPIC_API_KEY is absent",
        "firegrid.mcp_durable.anthropic_api_key_present": false,
      })
      return
    }

    const firegrid = yield* Firegrid
    const config = yield* FiregridConfig
    yield* firegrid.sessions.createOrLoad({
      externalKey: parentExternalKey,
      runtime: local.jsonl({
        argv: [...claudeAcpArgv],
        agent: "claude-acp",
        agentProtocol: "acp",
        cwd: globalThis.process.cwd(),
        envBindings: [
          { name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" },
        ],
      }),
      createdBy: "tiny-firegrid-simulation",
    })

    const client = yield* RpcClient.make(McpSchema.ClientRpcs).pipe(
      Effect.provide(layerProtocolDurableStreamsClient({
        durableStreamsBaseUrl: config.durableStreamsBaseUrl ?? "",
        namespace: config.namespace ?? "tiny-firegrid",
        transportId: "gateway",
      })),
    )

    const initialize = yield* client.initialize({
      protocolVersion: "2025-06-18",
      capabilities: new McpSchema.ClientCapabilities({}),
      clientInfo: {
        name: "tiny-firegrid-mcp-durable-streams-gateway",
        version: "0.0.0",
      },
    })
    const tools = yield* client["tools/list"](undefined)

    const sessionNew = yield* callTool(client, "session_new", {
      agentKind: "claude-acp",
      prompt: initialChildPrompt,
    })
    const childSessionId = childSessionIdFrom(toolStructuredContent(sessionNew))

    if (childSessionId === undefined) {
      yield* Effect.annotateCurrentSpan({
        "firegrid.mcp_durable.status": "session_new_no_structured_session",
        "firegrid.mcp_durable.tool_count": tools.tools.length,
        "firegrid.mcp_durable.server_protocol_version": initialize.protocolVersion,
      })
      return
    }

    const firstOutput = yield* callTool(client, "wait_for", {
      event: {
        channel: "session.agent_output",
        match: {
          sessionId: childSessionId,
          afterSequence: -1,
          "event._tag": "TextChunk",
        },
        timeoutMs: 60_000,
      },
    })
    const afterSequence = outputSequenceFrom(toolStructuredContent(firstOutput)) ?? -1
    const firstOutputEventTag = outputEventTagFrom(toolStructuredContent(firstOutput)) ?? ""

    yield* callTool(client, "session_prompt", {
      sessionId: childSessionId,
      prompt: permissionProbePrompt,
      inputId: "mcp-durable-permission-probe",
    })

    const permissionWait = yield* callTool(client, "wait_for", {
      event: {
        channel: "session.agent_output",
        match: {
          sessionId: childSessionId,
          afterSequence,
          "event._tag": "PermissionRequest",
        },
        timeoutMs: 60_000,
      },
      match: {
        sessionId: childSessionId,
        afterSequence,
        "event._tag": "PermissionRequest",
      },
      timeoutMs: 60_000,
    })
    const permission = permissionRequestSummary(toolStructuredContent(permissionWait))
    const permissionWaitEventTag = outputEventTagFrom(toolStructuredContent(permissionWait)) ?? ""

    const permissionResponseExit = yield* Effect.exit(
      callTool(client, "call", {
        channel: "approval.operator",
        request: {
          decision: { _tag: "Allow" },
          afterSequence,
          timeoutMs: 10_000,
          idempotencyKey: "mcp-durable-permission-allow",
        },
      }),
    )

    yield* Effect.annotateCurrentSpan({
      "firegrid.mcp_durable.status": permission.matched
        ? "permission_observed_mcp_response_attempted"
        : "permission_not_observed",
      "firegrid.mcp_durable.anthropic_api_key_present": true,
      "firegrid.mcp_durable.parent_context_id": parentContextId,
      "firegrid.mcp_durable.child_session_id": childSessionId,
      "firegrid.mcp_durable.tool_count": tools.tools.length,
      "firegrid.mcp_durable.tool_names": tools.tools.map(tool => tool.name).sort().join(","),
      "firegrid.mcp_durable.server_protocol_version": initialize.protocolVersion,
      "firegrid.mcp_durable.initial_output_sequence": afterSequence,
      "firegrid.mcp_durable.initial_output_event_tag": firstOutputEventTag,
      "firegrid.mcp_durable.permission_wait_event_tag": permissionWaitEventTag,
      "firegrid.mcp_durable.permission_observed": permission.matched,
      "firegrid.mcp_durable.permission_request_id": permission.permissionRequestId ?? "",
      "firegrid.mcp_durable.permission_response_exit": exitTag(permissionResponseExit),
      "firegrid.mcp_durable.spawn_target": claudeAcpArgv.join(" "),
    })
  })).pipe(
    Effect.withSpan("tiny_firegrid.mcp_durable.driver", {
      kind: "client",
    }),
  )
