import * as acp from "@agentclientprotocol/sdk"
import {
  Firegrid,
  FiregridConfig,
  type FiregridService,
  type FiregridSessionHandle,
  FiregridStandaloneLive,
  local,
} from "@firegrid/client-sdk/firegrid"
import type { RuntimeAgentOutputObservation } from "@firegrid/protocol/session-facade"
import { Effect, Layer } from "effect"

type RunEffect = <A>(effect: Effect.Effect<A, unknown, never>) => Promise<A>

interface FiregridAcpStdioHostEdgeOptions {
  readonly input: ReadableStream<Uint8Array>
  readonly output: WritableStream<Uint8Array>
  readonly durableStreamsBaseUrl: string
  readonly namespace: string
  readonly turnTimeoutMs?: number
}

export interface FiregridHostPlaneEdgeContext {
  readonly durableStreamsBaseUrl: string
  readonly namespace: string
}

export interface FiregridAcpStdioEdgeConfig {
  readonly _tag: "AcpStdio"
  readonly input: ReadableStream<Uint8Array>
  readonly output: WritableStream<Uint8Array>
  readonly turnTimeoutMs?: number
}

export type FiregridHostPlaneEdgeConfig = FiregridAcpStdioEdgeConfig

export interface FiregridHostPlaneEdgeTopology {
  readonly context: FiregridHostPlaneEdgeContext
  readonly edges: ReadonlyArray<FiregridHostPlaneEdgeConfig>
}

export const acpStdioEdge = (
  config: Omit<FiregridAcpStdioEdgeConfig, "_tag">,
): FiregridAcpStdioEdgeConfig => ({
  _tag: "AcpStdio",
  ...config,
})

interface EdgeSession {
  readonly acpSessionId: string
  readonly firegridSession: FiregridSessionHandle
  started: boolean
}

const turnTimeoutMsDefault = 10_000

const reject = <A>(message: string): Promise<A> =>
  Promise.reject(new Error(message))

const backingAgentProgram = `
const readline = require("node:readline")
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
let turn = 0
const write = value => process.stdout.write(JSON.stringify(value) + "\\n")
rl.on("line", line => {
  turn += 1
  let input = "unknown"
  try {
    const parsed = JSON.parse(line)
    input = parsed.correlationId || "prompt"
  } catch (_cause) {}
  write({ type: "text", messageId: "edge-message-" + turn, text: "firegrid acp edge observed " + input + " turn " + turn })
  write({ type: "turn_complete", messageId: "edge-message-" + turn, finishReason: "stop" })
})
`

const promptText = (request: acp.PromptRequest): string =>
  request.prompt.map((block) => {
    switch (block.type) {
      case "text":
        return block.text
      case "resource_link":
        return block.uri
      case "image":
        return `[image:${block.mimeType}]`
      case "audio":
        return `[audio:${block.mimeType}]`
      case "resource":
        return "[resource]"
    }
  }).join("\n")

const acpStopReason = (
  event: Extract<RuntimeAgentOutputObservation, { readonly _tag: "TurnComplete" }>["event"],
): acp.StopReason => {
  switch (event.finishReason) {
    case "length":
      return "max_tokens"
    case "content-filter":
      return "refusal"
    case "stop":
    case "tool-calls":
    case "error":
    case "pause":
    case "other":
    case "unknown":
      return "end_turn"
  }
}

class FiregridAcpHostEdgeAgent implements acp.Agent {
  private readonly sessions = new Map<string, EdgeSession>()
  private readonly turnTimeoutMs: number

  constructor(
    private readonly connection: acp.AgentSideConnection,
    private readonly firegrid: FiregridService,
    private readonly run: RunEffect,
    private readonly options: FiregridAcpStdioHostEdgeOptions,
  ) {
    this.turnTimeoutMs = options.turnTimeoutMs ?? turnTimeoutMsDefault
  }

  async initialize(): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false,
        },
      },
    }
  }

  async authenticate(): Promise<acp.AuthenticateResponse> {
    return {}
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const acpSessionId = `acp_${crypto.randomUUID()}`
    const firegridSession = await this.run(this.firegrid.sessions.createOrLoad({
      externalKey: {
        source: "tiny-firegrid.acp-edge",
        id: acpSessionId,
      },
      runtime: local.jsonl({
        argv: [
          globalThis.process.execPath,
          "-e",
          backingAgentProgram,
        ],
        agent: "tiny-firegrid-acp-edge-backing-agent",
        agentProtocol: "stdio-jsonl",
        cwd: params.cwd,
      }),
      createdBy: "tiny-firegrid-acp-edge",
    }))
    this.sessions.set(acpSessionId, {
      acpSessionId,
      firegridSession,
      started: false,
    })
    return { sessionId: acpSessionId }
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId)
    if (session === undefined) {
      return reject(`unknown ACP session ${params.sessionId}`)
    }

    await this.run(session.firegridSession.prompt({
      payload: promptText(params),
      idempotencyKey: params.messageId ?? `acp-prompt-${crypto.randomUUID()}`,
    }))

    if (!session.started) {
      await this.run(session.firegridSession.start())
      session.started = true
    }

    const turnComplete = await this.waitForTurnComplete(session)
    return {
      stopReason: acpStopReason(turnComplete.event),
      ...(params.messageId === undefined || params.messageId === null
        ? {}
        : { userMessageId: params.messageId }),
    }
  }

  async cancel(_params: acp.CancelNotification): Promise<void> {}

  private async waitForTurnComplete(
    session: EdgeSession,
  ): Promise<Extract<RuntimeAgentOutputObservation, { readonly _tag: "TurnComplete" }>> {
    for (;;) {
      const next = await this.run(session.firegridSession.wait.forAgentOutput({
        timeoutMs: this.turnTimeoutMs,
      }))
      if (!next.matched) {
        return reject("timed out waiting for Firegrid agent output")
      }
      await this.forwardOutput(session.acpSessionId, next.output)
      switch (next.output._tag) {
        case "TurnComplete":
          return next.output
        case "Terminated":
          return reject("Firegrid session terminated before ACP TurnComplete")
        default:
          break
      }
    }
  }

  private async forwardOutput(
    acpSessionId: string,
    output: RuntimeAgentOutputObservation,
  ): Promise<void> {
    switch (output._tag) {
      case "TextChunk":
        await this.connection.sessionUpdate({
          sessionId: acpSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: output.event.part.id,
            content: {
              type: "text",
              text: output.event.part.delta,
            },
          },
        })
        break
      case "ToolUse":
        await this.connection.sessionUpdate({
          sessionId: acpSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: output.event.part.id,
            title: output.event.part.name,
            kind: "other",
            status: "pending",
            rawInput: output.event.part.params,
          },
        })
        break
      case "Status":
        await this.connection.sessionUpdate({
          sessionId: acpSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: output.event.kind,
            },
          },
        })
        break
      case "Ready":
      case "PermissionRequest":
      case "TurnComplete":
      case "Error":
      case "Terminated":
        break
    }
  }
}

export const FiregridAcpStdioHostEdgeLive = (
  options: FiregridAcpStdioHostEdgeOptions,
): Layer.Layer<never, unknown> =>
  Layer.scopedDiscard(Effect.gen(function*() {
    const firegrid = yield* Firegrid
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const stream = acp.ndJsonStream(options.output, options.input)
        const connection = new acp.AgentSideConnection(
          client => new FiregridAcpHostEdgeAgent(
            client,
            firegrid,
            effect => Effect.runPromise(effect),
            options,
          ),
          stream,
        )
        return connection
      }),
      () => Effect.void,
    )
  })).pipe(
    Layer.provide(
      FiregridStandaloneLive.pipe(
        Layer.provide(
          Layer.succeed(FiregridConfig, {
            durableStreamsBaseUrl: options.durableStreamsBaseUrl,
            namespace: options.namespace,
          }),
        ),
      ),
    ),
  )

export const FiregridHostPlaneEdgeLive = (
  context: FiregridHostPlaneEdgeContext,
  edge: FiregridHostPlaneEdgeConfig,
): Layer.Layer<never, unknown> => {
  switch (edge._tag) {
    case "AcpStdio":
      return FiregridAcpStdioHostEdgeLive({
        input: edge.input,
        output: edge.output,
        durableStreamsBaseUrl: context.durableStreamsBaseUrl,
        namespace: context.namespace,
        ...(edge.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: edge.turnTimeoutMs }),
      })
  }
}

export const FiregridHostPlaneEdgesLive = (
  topology: FiregridHostPlaneEdgeTopology,
): Layer.Layer<never, unknown> =>
  topology.edges.reduce(
    (layer, edge) =>
      Layer.mergeAll(layer, FiregridHostPlaneEdgeLive(topology.context, edge)),
    Layer.empty as Layer.Layer<never, unknown>,
  )
