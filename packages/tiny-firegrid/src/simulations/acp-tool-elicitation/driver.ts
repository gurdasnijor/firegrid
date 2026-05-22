import * as acp from "@agentclientprotocol/sdk"
import { Duration, Effect } from "effect"
import { elicitationHarness } from "./harness.ts"
import { elicitationPrompts, type ElicitationPrompt } from "./prompts.ts"

// Backstop per-turn timeout via Effect's clock (no JS timer): the edge's own
// turnTimeoutMs (30s) usually fires first; this guards a prompt() that never
// settles, and keeps one hung turn from consuming the whole runner budget.
const PER_TURN_TIMEOUT = Duration.seconds(60)

interface TurnResult {
  readonly label: string
  readonly stopReason?: acp.StopReason
  readonly error?: string
  readonly text: string
  readonly toolCalls: ReadonlyArray<string>
}

const textFromUpdates = (
  updates: ReadonlyArray<acp.SessionNotification>,
): string =>
  updates
    .flatMap(({ update }) =>
      update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
        ? [update.content.text]
        : [])
    .join("")

const toolCallsFromUpdates = (
  updates: ReadonlyArray<acp.SessionNotification>,
): ReadonlyArray<string> => {
  const names = updates.flatMap(({ update }) =>
    update.sessionUpdate === "tool_call" && typeof update.title === "string"
      ? [update.title]
      : [])
  return [...new Set(names)]
}

// Concrete ACP client. We advertise no fs/terminal capabilities, so only the
// two required `acp.Client` methods are implemented; the agent never invokes
// the optional capability methods. Session updates are buffered per turn so the
// driver can read the agent's streamed text + tool-call names after each prompt.
class ElicitationClient implements acp.Client {
  private updates: Array<acp.SessionNotification> = []

  /** Clear the per-turn buffer before issuing a prompt. */
  beginTurn(): void {
    this.updates = []
  }

  /** Concatenated agent text streamed during the current turn. */
  text(): string {
    return textFromUpdates(this.updates)
  }

  /** Distinct tool-call names observed during the current turn. */
  toolCalls(): ReadonlyArray<string> {
    return toolCallsFromUpdates(this.updates)
  }

  sessionUpdate(params: acp.SessionNotification): Promise<void> {
    this.updates.push(params)
    return Promise.resolve()
  }

  // Auto-approve, mirroring the stdio edge's post-#628 behavior.
  requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    return Promise.resolve({
      outcome: { outcome: "selected", optionId: params.options[0]?.optionId ?? "allow" },
    })
  }
}

// One agent turn = one span. The prompt label, stop reason, streamed text, and
// tool-call names land as span attributes (the span's own duration captures
// timing), so the runner's captured trace — and its DuckDB/OTLP bundle — is the
// transcript; no separate artifact file.
const runTurn = (
  connection: acp.ClientSideConnection,
  sessionId: string,
  prompt: ElicitationPrompt,
  client: ElicitationClient,
): Effect.Effect<TurnResult, never> =>
  Effect.sync(() => client.beginTurn()).pipe(
    Effect.zipRight(
      Effect.tryPromise({
        try: () => connection.prompt({ sessionId, prompt: [{ type: "text", text: prompt.text }] }),
        catch: (cause) => cause,
      }).pipe(Effect.timeout(PER_TURN_TIMEOUT)),
    ),
    Effect.map((response): TurnResult => ({
      label: prompt.label,
      stopReason: response.stopReason,
      text: client.text(),
      toolCalls: client.toolCalls(),
    })),
    Effect.catchAll((cause) =>
      Effect.succeed<TurnResult>({
        label: prompt.label,
        error: cause instanceof Error ? cause.message : String(cause),
        text: client.text(),
        toolCalls: client.toolCalls(),
      })),
    Effect.tap((result) =>
      Effect.annotateCurrentSpan({
        "firegrid.acp_elicitation.label": result.label,
        "firegrid.acp_elicitation.stop_reason": result.stopReason ?? "",
        "firegrid.acp_elicitation.error": result.error ?? "",
        "firegrid.acp_elicitation.tool_calls": result.toolCalls.join(","),
        // bounded: keep the trace readable
        "firegrid.acp_elicitation.text": result.text.slice(0, 2000),
      })),
    Effect.withSpan("firegrid.acp_tool_elicitation.turn", {
      kind: "client",
      attributes: { "firegrid.acp_elicitation.prompt_label": prompt.label },
    }),
  )

interface ElicitationResult {
  readonly sessionId: string
  readonly turns: ReadonlyArray<TurnResult>
}

// The host authorizes ANTHROPIC_API_KEY into the agent subprocess
// (FiregridEnvBindingsFromEnv); if it is absent the agent fails to authenticate
// and every turn records an error — surfaced in the trace rather than gated
// here (reading process.env from a simulation is disallowed by repo policy).
export const acpToolElicitationDriver: Effect.Effect<ElicitationResult, unknown> = Effect.gen(
  function*() {
    const client = new ElicitationClient()
    const stream = acp.ndJsonStream(
      elicitationHarness.clientOutput,
      elicitationHarness.clientInput,
    )
    const connection = new acp.ClientSideConnection(() => client, stream)

    const session = yield* Effect.promise(async () => {
      await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      })
      return connection.newSession({ cwd: globalThis.process.cwd(), mcpServers: [] })
    })

    const turns = yield* Effect.forEach(
      elicitationPrompts,
      (prompt) => runTurn(connection, session.sessionId, prompt, client),
      { concurrency: 1 },
    )

    return { sessionId: session.sessionId, turns }
  },
).pipe(
  Effect.tap((result) =>
    Effect.annotateCurrentSpan({
      "firegrid.acp_tool_elicitation.acp_session_id": result.sessionId,
      "firegrid.acp_tool_elicitation.turn_count": result.turns.length,
      "firegrid.acp_tool_elicitation.error_count": result.turns.filter((t) => t.error !== undefined).length,
    })),
  Effect.withSpan("firegrid.acp_tool_elicitation.driver", {
    kind: "client",
    attributes: { "firegrid.acid": "firegrid-zed-acp-stdio-external-agent.VALIDATION.4" },
  }),
)
