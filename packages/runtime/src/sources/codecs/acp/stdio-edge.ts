import * as acp from "@agentclientprotocol/sdk"
import { WorkflowEngine } from "@effect/workflow"
import {
  HostSessionsCreateOrLoadChannel,
  SessionAgentOutputChannel,
  SessionPromptChannel,
} from "@firegrid/protocol/channels"
import {
  type PublicLaunchRuntimeIntent,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import { respondPermissionDecision } from "../../../unified/channel-bindings.ts"
import { runtimeIngressInputIdForIdempotencyKey } from "@firegrid/protocol/runtime-ingress"
import type { RuntimeAgentOutputObservation } from "@firegrid/protocol/session-facade"
import { Clock, Context, Duration, Effect, Layer, Option, Runtime, Stream } from "effect"

type RunEffect = <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>

export class AcpContextRows extends Context.Tag(
  "firegrid/runtime/sources/codecs/acp/AcpContextRows",
)<AcpContextRows, Stream.Stream<RuntimeContext, unknown>>() {}

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
  /**
   * How the edge answers a RuntimeAgentOutput PermissionRequest (tf-l5px/tf-jvjm):
   * - `"forward"` (default, safe): ask the connected ACP client (Zed's native
   *   permission UI) via `AgentSideConnection.requestPermission` and map the
   *   selected/rejected/cancelled outcome back through `host.permissions.respond`.
   * - `"deny"`: reject every request without prompting (a safe non-interactive
   *   default for local/CI testing).
   * - `"allow"`: auto-allow without prompting — must be an intentional operator
   *   choice (not the default).
   *
   * Every branch still dispatches a typed decision through the same
   * `host.permissions.respond` route: this selects WHICH decision, never who
   * owns the permission authority.
   */
  readonly permissionPolicy?: AcpPermissionPolicy
}

// tf-jvjm: the explicit ACP permission policy surface. "forward" is the safe
// default; "allow" is an intentional operator opt-in.
export type AcpPermissionPolicy = "forward" | "deny" | "allow"
export const acpPermissionPolicies: ReadonlyArray<AcpPermissionPolicy> = [
  "forward",
  "deny",
  "allow",
]
export const defaultAcpPermissionPolicy: AcpPermissionPolicy = "forward"

// tf-l5px: structural shape of the decision dispatched to host.permissions.respond.
type EdgePermissionDecision =
  | { readonly _tag: "Allow"; readonly optionId?: string }
  | { readonly _tag: "Deny" }
  | { readonly _tag: "Cancelled" }

export interface AcpStdioEdgeService {
  readonly closed: Effect.Effect<void, unknown>
}

interface AcpStdioEdgeContextTimeout {
  readonly _tag: "AcpStdioEdgeContextTimeout"
  readonly contextId: string
}

// tf-lgb1: a single `reason: "timeout"` used to collapse agent silence, an
// unanswered permission request, a hung tool call, a closed output stream, and
// process termination into one opaque 30s failure. The typed reason tells a
// live Zed failure which subsystem is stuck without DuckDB archaeology.
type AcpStdioEdgeTurnTimeoutReason =
  // the idle timeout fired and the last output the edge saw was...
  | "agent_silent" // ...nothing, or text/status — the agent just went quiet
  | "permission_unanswered" // ...a PermissionRequest — the turn never resumed
  | "tool_call_in_flight" // ...a ToolUse — the tool call never produced output
  // terminal observations (not idle timeouts)
  | "process_terminated" // a Terminated observation arrived before TurnComplete
  | "stream_ended" // the output stream closed before TurnComplete

interface AcpStdioEdgeTurnOutputError {
  readonly _tag: "AcpStdioEdgeTurnOutputError"
  readonly reason: AcpStdioEdgeTurnTimeoutReason
  readonly message: string
}

// Classify an idle-timeout (no output within turnTimeoutMs) from the last
// output observation the edge saw this turn. Pure so it is unit-testable for
// every category, including ones the stdio-jsonl test harness cannot emit
// (e.g. PermissionRequest).
export const classifyTurnIdleTimeoutReason = (
  lastOutputTag: RuntimeAgentOutputObservation["_tag"] | undefined,
): AcpStdioEdgeTurnTimeoutReason => {
  switch (lastOutputTag) {
    case "PermissionRequest":
      return "permission_unanswered"
    case "ToolUse":
      return "tool_call_in_flight"
    default:
      return "agent_silent"
  }
}

const turnTimeoutMessage = (reason: AcpStdioEdgeTurnTimeoutReason): string => {
  switch (reason) {
    case "agent_silent":
      return "timed out waiting for Firegrid agent output (agent produced no further output)"
    case "permission_unanswered":
      return "timed out after a permission request; the turn did not resume after the permission decision"
    case "tool_call_in_flight":
      return "timed out with a tool call in flight; the agent produced no output after the tool call"
    case "process_terminated":
      return "Firegrid session terminated before ACP TurnComplete"
    case "stream_ended":
      return "Firegrid agent output stream ended before ACP TurnComplete"
  }
}

const acpStdioEdgeContextTimeout = (
  contextId: string,
): AcpStdioEdgeContextTimeout => ({
  _tag: "AcpStdioEdgeContextTimeout",
  contextId,
})

const acpStdioEdgeTurnOutputError = (
  reason: AcpStdioEdgeTurnTimeoutReason,
): AcpStdioEdgeTurnOutputError => ({
  _tag: "AcpStdioEdgeTurnOutputError",
  reason,
  message: turnTimeoutMessage(reason),
})

const isTurnOutputError = (
  error: unknown,
): error is AcpStdioEdgeTurnOutputError =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  (error as { readonly _tag: unknown })._tag === "AcpStdioEdgeTurnOutputError"

// Turn-local state used to classify a turn timeout. Mutated by the single
// output-consuming fiber as observations arrive; read lazily when the idle
// timeout fires or the span outcome is annotated.
interface TurnOutputState {
  outputCount: number
  lastOutputTag?: RuntimeAgentOutputObservation["_tag"]
}

export class AcpStdioEdge extends Context.Tag(
  "firegrid/host-sdk/AcpStdioEdge",
)<AcpStdioEdge, AcpStdioEdgeService>() {}

interface EdgeSession {
  readonly acpSessionId: string
  readonly contextId: string
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
    private readonly createOrLoad: HostSessionsCreateOrLoadChannel["Type"],
    private readonly sessionPrompt: SessionPromptChannel["Type"],
    private readonly engine: WorkflowEngine.WorkflowEngine["Type"],
    private readonly contexts: AcpContextRows["Type"],
    private readonly sessionAgentOutput: SessionAgentOutputChannel["Type"],
    private readonly run: RunEffect,
    private readonly options: AcpStdioEdgeOptions,
  ) {
    this.turnTimeoutMs = options.turnTimeoutMs ?? turnTimeoutMsDefault
  }

  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return this.run(
      Effect.succeed({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: {
            image: false,
            audio: false,
            embeddedContext: false,
          },
        },
      }).pipe(
        Effect.withSpan("firegrid.acp_stdio_edge.initialize", {
          kind: "server",
          attributes: {
            "firegrid.acid": "firegrid-zed-acp-stdio-external-agent.ACP_STDIO_EDGE.7",
            "firegrid.acp.protocol_version": acp.PROTOCOL_VERSION,
          },
        }),
      ),
    )
  }

  async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    return reject("ACP authenticate is not implemented by the Firegrid stdio edge")
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const createOrLoad = this.createOrLoad
    const options = this.options
    const sessions = this.sessions
    const waitForContext = (contextId: string) => this.waitForContext(contextId)
    const acpSessionId = `acp_${crypto.randomUUID()}`
    const runtime = runtimeForSession(options, {
      acpSessionId,
      request: params,
    })

    return this.run(
      Effect.gen(function*() {
        // firegrid-zed-acp-stdio-external-agent.ACP_STDIO_EDGE.2
        // tf-s9uj: call the host create-or-load channel binding DIRECTLY (no
        // host-plane router); the typed call returns the session handle. Terminal
        // prompt completion is NOT modeled here — see the prompt() path / tf-r6br
        // STOP report (gated on the durable output cursor, tf-aseo).
        const created = yield* createOrLoad.binding.call({
          externalKey: {
            source: options.externalKeySource ?? defaultExternalKeySource,
            id: acpSessionId,
          },
          runtime,
          createdBy: options.createdBy ?? defaultCreatedBy,
        })
        yield* Effect.annotateCurrentSpan({
          "firegrid.context.id": created.contextId,
          "firegrid.session.id": created.sessionId,
        })
        yield* waitForContext(created.contextId)
        sessions.set(acpSessionId, {
          acpSessionId,
          contextId: created.contextId,
        })
        return { sessionId: acpSessionId }
      }).pipe(
        Effect.withSpan("firegrid.acp_stdio_edge.new_session", {
          kind: "server",
          attributes: {
            "firegrid.acid": "firegrid-zed-acp-stdio-external-agent.ACP_STDIO_EDGE.7",
            "firegrid.acp.session_id": acpSessionId,
            "firegrid.acp.request.mcp_server_count": params.mcpServers?.length ?? 0,
            "firegrid.acp.cwd_present": params.cwd !== undefined,
          },
        }),
      ),
    )
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const sessionPrompt = this.sessionPrompt
    const waitForTurnComplete = (session: EdgeSession) => this.waitForTurnCompleteEffect(session)
    const session = this.sessions.get(params.sessionId)
    if (session === undefined) {
      return reject(`unknown ACP session ${params.sessionId}`)
    }
    const clientPromptId = params.messageId ?? `acp-prompt-${crypto.randomUUID()}`
    const turnId = runtimeIngressInputIdForIdempotencyKey(session.contextId, clientPromptId)

    return this.run(
      Effect.gen(function*() {
        yield* Effect.annotateCurrentSpan({
          "firegrid.context.id": session.contextId,
          "firegrid.acp.client_prompt_id": clientPromptId,
          "firegrid.acp.prompt_id": turnId,
          "firegrid.acp.turn_id": turnId,
          "firegrid.input.correlation_id": turnId,
        })
        // firegrid-zed-acp-stdio-external-agent.ACP_STDIO_EDGE.3
        // tf-s9uj: append to the per-session prompt channel binding DIRECTLY.
        // The session.start ack was vestigial — the real spawn happens when this
        // prompt drives the RuntimeContext workflow body (startOrAttach on first
        // input), so no separate start dispatch is needed.
        yield* sessionPrompt.forSession(session.contextId).binding.append({
          payload: promptText(params),
          idempotencyKey: clientPromptId,
        })

        const turnComplete = yield* waitForTurnComplete(session)
        return {
          stopReason: acpStopReason(turnComplete.event),
          ...(params.messageId === undefined || params.messageId === null
            ? {}
            : { userMessageId: params.messageId }),
        }
      }).pipe(
        Effect.withSpan("firegrid.acp_stdio_edge.prompt", {
          kind: "server",
          attributes: {
            "firegrid.acid": "firegrid-zed-acp-stdio-external-agent.ACP_STDIO_EDGE.7",
            "firegrid.acp.session_id": params.sessionId,
            "firegrid.acp.client_prompt_id": clientPromptId,
            "firegrid.acp.prompt_id": turnId,
            "firegrid.acp.turn_id": turnId,
            "firegrid.input.correlation_id": turnId,
            "firegrid.acp.message_id_present": params.messageId !== undefined && params.messageId !== null,
            "firegrid.acp.prompt_part_count": params.prompt.length,
          },
        }),
      ),
    )
  }

  async cancel(_params: acp.CancelNotification): Promise<void> {
    return reject("ACP cancel is not implemented by the Firegrid stdio edge")
  }

  private waitForContext(
    contextId: string,
  ): Effect.Effect<void, unknown> {
    const wait = this.contexts.pipe(
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

  // tf-t7rb (Phase 0C F5 "cheap win"): consume one long-lived output
  // subscription per turn instead of re-creating the stream + Stream.runHead on
  // every output. The prior loop re-subscribed from the source head per output,
  // and `rows()` replays its initial state on each subscription
  // (DurableTable.rows -> subscribeChanges({ includeInitialState: true })), so a
  // turn of N outputs cost O(N^2) initial-state replays — the consumer-side
  // analogue of tf-7kq8. Here the ordered stream is filtered once past the
  // turn's start sequence, each output is forwarded as it arrives, and the
  // subscription stops at the terminal observation. Terminal-ness comes ONLY
  // from a TurnComplete/Terminated output observation; no route-completion
  // metadata is consulted. The volatile per-connection cursor (lastSequence)
  // and the per-output idle timeout are preserved.
  private waitForTurnCompleteEffect(
    session: EdgeSession,
  ): Effect.Effect<Extract<RuntimeAgentOutputObservation, { readonly _tag: "TurnComplete" }>, unknown> {
    const forwardOutput = (output: RuntimeAgentOutputObservation) =>
      this.forwardOutput(session.acpSessionId, output)
    const startSequence = session.lastSequence
    const channel = this.sessionAgentOutput.forContext(session.contextId)
    // tf-lgb1: track what the turn last saw so a timeout can name which
    // subsystem is stuck. The stream is consumed by one fiber, so a plain
    // mutable record is enough; the timeoutFail thunk reads it lazily.
    const turn: TurnOutputState = { outputCount: 0 }
    const annotateTurn = (extra: Record<string, string | number>) =>
      Effect.annotateCurrentSpan({
        "firegrid.acp.turn.output_count": turn.outputCount,
        "firegrid.acp.turn.last_output_tag": turn.lastOutputTag ?? "none",
        ...extra,
      })
    return channel.binding.stream.pipe(
      Stream.filter(observation =>
        observation.contextId === session.contextId &&
        (startSequence === undefined || observation.sequence > startSequence),
      ),
      // Idle timeout: fail the turn if the next output does not arrive in time
      // (preserves the prior per-output Clock.sleep(turnTimeoutMs) semantics).
      // The reason is classified from the last output seen so far.
      Stream.timeoutFail(
        () =>
          acpStdioEdgeTurnOutputError(
            classifyTurnIdleTimeoutReason(turn.lastOutputTag),
          ),
        Duration.millis(this.turnTimeoutMs),
      ),
      Stream.mapEffect(output =>
        Effect.gen(function*() {
          turn.outputCount += 1
          turn.lastOutputTag = output._tag
          session.lastSequence = output.sequence
          yield* Effect.tryPromise(() => forwardOutput(output))
          return output
        }),
      ),
      Stream.takeUntil(output =>
        output._tag === "TurnComplete" || output._tag === "Terminated",
      ),
      Stream.runLast,
      Effect.flatMap(Option.match({
        onNone: () => Effect.fail(acpStdioEdgeTurnOutputError("stream_ended")),
        onSome: output =>
          output._tag === "TurnComplete"
            ? Effect.succeed(output)
            : Effect.fail(acpStdioEdgeTurnOutputError("process_terminated")),
      })),
      // tf-lgb1: annotate the turn span with the outcome + the classified
      // timeout reason so a live Zed failure is triageable from the trace.
      Effect.tap(() => annotateTurn({ "firegrid.acp.turn.outcome": "completed" })),
      Effect.tapError(error =>
        annotateTurn({
          "firegrid.acp.turn.outcome": "failed",
          ...(isTurnOutputError(error)
            ? { "firegrid.acp.turn.timeout_reason": error.reason }
            : {}),
        })),
      Effect.withSpan("firegrid.acp_stdio_edge.turn_output", {
        kind: "internal",
        attributes: {
          "firegrid.acid": "firegrid-zed-acp-stdio-external-agent.ACP_STDIO_EDGE.7",
          "firegrid.context.id": session.contextId,
        },
      }),
    )
  }

  private async forwardOutput(
    acpSessionId: string,
    output: RuntimeAgentOutputObservation,
  ): Promise<void> {
    // firegrid-zed-acp-stdio-external-agent.ACP_STDIO_EDGE.8
    switch (output._tag) {
      case "Ready":
        return
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
        return
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
        return
      case "Status":
        // firegrid-zed-acp-stdio-external-agent.ACP_STDIO_EDGE.6
        return
      case "PermissionRequest":
        // tf-46i4/tf-l5px: ACP permission requests are request/response protocol
        // messages. Dropping one leaves the codec waiting and deadlocks the turn.
        // Default: forward to the connected ACP client (Zed's native permission
        // UI) and answer with the human decision; "allow" policy auto-grants.
        await this.answerPermissionRequest(acpSessionId, output)
        return
      case "TurnComplete":
        return
      case "Error":
        return
      case "Terminated":
        return
    }
    const exhaustive: never = output
    return exhaustive
  }

  // tf-l5px: answer a PermissionRequest. The invariant is that ACP is always
  // owed a response — every path resolves to a typed decision dispatched through
  // the existing host.permissions.respond route (the edge already owns this
  // seam; this only changes WHICH decision is sent).
  private async answerPermissionRequest(
    acpSessionId: string,
    output: Extract<RuntimeAgentOutputObservation, { readonly _tag: "PermissionRequest" }>,
  ): Promise<void> {
    const policy = this.options.permissionPolicy ?? defaultAcpPermissionPolicy
    const decision: EdgePermissionDecision =
      policy === "allow"
        ? { _tag: "Allow" }
        : policy === "deny"
        ? { _tag: "Deny" }
        : await this.requestPermissionFromClient(acpSessionId, output)
    await this.run(
      respondPermissionDecision({
        engine: this.engine,
        request: {
          contextId: output.contextId,
          permissionRequestId: output.event.permissionRequestId,
          decision,
        },
      }),
    )
  }

  // Forward to the connected ACP client (Zed's native permission UI) and map the
  // outcome to a Firegrid decision. selected -> Allow (with the chosen optionId)
  // or Deny when the selected option is a reject_* kind; cancelled -> Cancelled.
  // Any failure (client without a permission surface, connection gone) still
  // resolves to Cancelled so the codec wait never hangs (mirrors tf-90w5).
  private async requestPermissionFromClient(
    acpSessionId: string,
    output: Extract<RuntimeAgentOutputObservation, { readonly _tag: "PermissionRequest" }>,
  ): Promise<EdgePermissionDecision> {
    // `toolUseId`/`options` are optional on the observation type; default
    // defensively (a non-empty toolCallId is required, empty options simply
    // leaves the client nothing to select -> cancelled).
    const options = output.options ?? []
    try {
      const response = await this.connection.requestPermission({
        sessionId: acpSessionId,
        toolCall: { toolCallId: output.toolUseId ?? output.permissionRequestId ?? "permission" },
        options: options.map(option => ({
          optionId: option.optionId,
          kind: option.kind,
          name: option.name,
        })),
      })
      const outcome = response.outcome
      if (outcome.outcome !== "selected") {
        return { _tag: "Cancelled" }
      }
      const selected = options.find(option => option.optionId === outcome.optionId)
      const rejected = selected !== undefined &&
        (selected.kind === "reject_once" || selected.kind === "reject_always")
      return rejected ? { _tag: "Deny" } : { _tag: "Allow", optionId: outcome.optionId }
    } catch {
      return { _tag: "Cancelled" }
    }
  }
}

export const AcpStdioEdgeLive = (
  options: AcpStdioEdgeOptions,
): Layer.Layer<
  AcpStdioEdge,
  never,
  | HostSessionsCreateOrLoadChannel
  | SessionPromptChannel
  | WorkflowEngine.WorkflowEngine
  | AcpContextRows
  | SessionAgentOutputChannel
> =>
  Layer.scoped(
    AcpStdioEdge,
    Effect.gen(function*() {
      const createOrLoad = yield* HostSessionsCreateOrLoadChannel
      const sessionPrompt = yield* SessionPromptChannel
      const engine = yield* WorkflowEngine.WorkflowEngine
      const contexts = yield* AcpContextRows
      const sessionAgentOutput = yield* SessionAgentOutputChannel
      const runtime = yield* Effect.runtime<never>()
      const runPromise = Runtime.runPromise(runtime)
      const connection = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const stream = acp.ndJsonStream(options.output, options.input)
          return new acp.AgentSideConnection(
            client => new FiregridAcpStdioAgent(
              client,
              createOrLoad,
              sessionPrompt,
              engine,
              contexts,
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
