import * as acp from "@agentclientprotocol/sdk"
import {
  HostContextsChannel,
  HostSessionsCreateOrLoadChannelTarget,
  HostSessionsStartChannelTarget,
  SessionAgentOutputChannel,
  SessionPromptChannelTarget,
} from "@firegrid/protocol/channels"
import type { PublicLaunchRuntimeIntent } from "@firegrid/protocol/launch"
import type { RuntimeAgentOutputObservation } from "@firegrid/protocol/session-facade"
import { HostPlaneChannelRouter } from "@firegrid/runtime/channels"
import { Clock, Context, Duration, Effect, Layer, Option, Runtime, Stream } from "effect"

type RunEffect = <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>

export interface AcpStdioSessionRuntimeRequest {
  readonly acpSessionId: string
  readonly request: acp.NewSessionRequest
}

export interface AcpStdioEdgeOptions {
  readonly input: ReadableStream<Uint8Array>
  readonly output: WritableStream<Uint8Array>
  readonly runtime:
    | PublicLaunchRuntimeIntent
    | ((request: AcpStdioSessionRuntimeRequest) => PublicLaunchRuntimeIntent)
  readonly createdBy?: string
  readonly externalKeySource?: string
  readonly turnTimeoutMs?: number
}

export interface AcpStdioEdgeService {
  readonly closed: Effect.Effect<void, unknown>
}

interface AcpStdioEdgeContextTimeout {
  readonly _tag: "AcpStdioEdgeContextTimeout"
  readonly contextId: string
}

const acpStdioEdgeContextTimeout = (
  contextId: string,
): AcpStdioEdgeContextTimeout => ({
  _tag: "AcpStdioEdgeContextTimeout",
  contextId,
})

export class AcpStdioEdge extends Context.Tag(
  "firegrid/host-sdk/AcpStdioEdge",
)<AcpStdioEdge, AcpStdioEdgeService>() {}

interface EdgeSession {
  readonly acpSessionId: string
  readonly contextId: string
  started: boolean
  lastSequence?: number
}

const turnTimeoutMsDefault = 30_000
const defaultCreatedBy = "firegrid:acp-stdio-edge"
const defaultExternalKeySource = "firegrid:acp-stdio-edge"

const reject = <A>(message: string): Promise<A> =>
  Promise.reject(new Error(message))

const runtimeForSession = (
  options: AcpStdioEdgeOptions,
  request: AcpStdioSessionRuntimeRequest,
): PublicLaunchRuntimeIntent =>
  typeof options.runtime === "function" ? options.runtime(request) : options.runtime

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
  event: Extract<
    RuntimeAgentOutputObservation,
    { readonly _tag: "TurnComplete" }
  >["event"],
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

class FiregridAcpStdioAgent implements acp.Agent {
  private readonly sessions = new Map<string, EdgeSession>()
  private readonly turnTimeoutMs: number

  constructor(
    private readonly connection: acp.AgentSideConnection,
    private readonly router: HostPlaneChannelRouter["Type"],
    private readonly hostContexts: HostContextsChannel["Type"],
    private readonly sessionAgentOutput: SessionAgentOutputChannel["Type"],
    private readonly run: RunEffect,
    private readonly options: AcpStdioEdgeOptions,
  ) {
    this.turnTimeoutMs = options.turnTimeoutMs ?? turnTimeoutMsDefault
  }

  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
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

  async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    return reject("ACP authenticate is not implemented by the Firegrid stdio edge")
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const acpSessionId = `acp_${crypto.randomUUID()}`
    const runtime = runtimeForSession(this.options, {
      acpSessionId,
      request: params,
    })

    // firegrid-zed-acp-stdio-external-agent.ACP_STDIO_EDGE.2
    const created = await this.run(this.router.dispatch({
      target: HostSessionsCreateOrLoadChannelTarget,
      verb: "call",
      payload: {
        externalKey: {
          source: this.options.externalKeySource ?? defaultExternalKeySource,
          id: acpSessionId,
        },
        runtime,
        createdBy: this.options.createdBy ?? defaultCreatedBy,
      },
    })) as { readonly contextId: string; readonly sessionId: string }
    await this.run(this.waitForContext(created.contextId))
    this.sessions.set(acpSessionId, {
      acpSessionId,
      contextId: created.contextId,
      started: false,
    })
    return { sessionId: acpSessionId }
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId)
    if (session === undefined) {
      return reject(`unknown ACP session ${params.sessionId}`)
    }

    // firegrid-zed-acp-stdio-external-agent.ACP_STDIO_EDGE.3
    await this.run(this.router.dispatch({
      target: SessionPromptChannelTarget,
      verb: "send",
      payload: {
        sessionId: session.contextId,
        prompt: {
          payload: promptText(params),
          idempotencyKey: params.messageId ?? `acp-prompt-${crypto.randomUUID()}`,
        },
      },
    }))

    if (!session.started) {
      await this.run(this.router.dispatch({
        target: HostSessionsStartChannelTarget,
        verb: "call",
        payload: { sessionId: session.contextId },
      }))
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

  async cancel(_params: acp.CancelNotification): Promise<void> {
    return reject("ACP cancel is not implemented by the Firegrid stdio edge")
  }

  private waitForContext(
    contextId: string,
  ): Effect.Effect<void, unknown> {
    const wait = this.hostContexts.binding.stream.pipe(
      Stream.filter(context => context.contextId === contextId),
      Stream.runHead,
      Effect.as(true),
    )
    return Effect.raceFirst(
      wait,
      Clock.sleep(Duration.millis(this.turnTimeoutMs)).pipe(Effect.as(false)),
    ).pipe(
      Effect.flatMap(matched =>
        matched
          ? Effect.void
          : Effect.fail(acpStdioEdgeContextTimeout(contextId)),
      ),
    )
  }

  private waitForAgentOutput(
    session: EdgeSession,
  ): Effect.Effect<Option.Option<RuntimeAgentOutputObservation>, unknown> {
    const channel = this.sessionAgentOutput.forContext(session.contextId)
    const run = channel.binding.stream.pipe(
      Stream.filter(observation =>
        observation.contextId === session.contextId &&
        (session.lastSequence === undefined ||
          observation.sequence > session.lastSequence),
      ),
      Stream.runHead,
    )
    return Effect.raceFirst(
      run,
      Clock.sleep(Duration.millis(this.turnTimeoutMs)).pipe(
        Effect.as(Option.none<RuntimeAgentOutputObservation>()),
      ),
    )
  }

  private async waitForTurnComplete(
    session: EdgeSession,
  ): Promise<Extract<RuntimeAgentOutputObservation, { readonly _tag: "TurnComplete" }>> {
    for (;;) {
      const next = await this.run(this.waitForAgentOutput(session))
      if (Option.isNone(next)) {
        return reject("timed out waiting for Firegrid agent output")
      }
      const output = next.value
      session.lastSequence = output.sequence
      await this.forwardOutput(session.acpSessionId, output)
      switch (output._tag) {
        case "TurnComplete":
          return output
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
        // firegrid-zed-acp-stdio-external-agent.ACP_STDIO_EDGE.6
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

export const AcpStdioEdgeLive = (
  options: AcpStdioEdgeOptions,
): Layer.Layer<
  AcpStdioEdge,
  never,
  HostPlaneChannelRouter | HostContextsChannel | SessionAgentOutputChannel
> =>
  Layer.scoped(
    AcpStdioEdge,
    Effect.gen(function*() {
      const router = yield* HostPlaneChannelRouter
      const hostContexts = yield* HostContextsChannel
      const sessionAgentOutput = yield* SessionAgentOutputChannel
      const runtime = yield* Effect.runtime<never>()
      const runPromise = Runtime.runPromise(runtime)
      const connection = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const stream = acp.ndJsonStream(options.output, options.input)
          return new acp.AgentSideConnection(
            client => new FiregridAcpStdioAgent(
              client,
              router,
              hostContexts,
              sessionAgentOutput,
              runPromise,
              options,
            ),
            stream,
          )
        }),
        () => Effect.void,
      )
      return AcpStdioEdge.of({
        closed: Effect.tryPromise(() => connection.closed),
      })
    }),
  )
