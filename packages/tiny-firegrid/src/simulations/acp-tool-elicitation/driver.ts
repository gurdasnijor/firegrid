import * as acp from "@agentclientprotocol/sdk"
import { Effect } from "effect"
import { elicitationHarness } from "./harness.ts"
import { elicitationPrompts, type ElicitationPrompt } from "./prompts.ts"

// Backstop per-turn timeout. The edge's own turnTimeoutMs (30s) usually fires
// first; this guards the case where a prompt() never settles.
const PER_TURN_TIMEOUT_MS = 60_000

interface TurnResult {
  readonly label: string
  readonly ms: number
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

const withTimeout = <A>(promise: Promise<A>, ms: number, label: string): Promise<A> =>
  Promise.race([
    promise,
    new Promise<A>((_, reject) =>
      setTimeout(() => reject(new Error(`turn timeout after ${ms}ms (${label})`)), ms)),
  ])

// One agent turn = one span. The prompt, stop reason, duration, streamed text,
// and tool-call names land as span attributes, so the runner's captured trace
// (and the DuckDB/OTLP bundle) is the transcript — no separate artifact file.
const runTurn = (
  connection: acp.ClientSideConnection,
  sessionId: string,
  prompt: ElicitationPrompt,
  client: ElicitationClient,
): Effect.Effect<TurnResult, never> =>
  Effect.promise(async (): Promise<TurnResult> => {
    client.beginTurn()
    const start = Date.now()
    let stopReason: acp.StopReason | undefined
    let error: string | undefined
    try {
      const res = await withTimeout(
        connection.prompt({ sessionId, prompt: [{ type: "text", text: prompt.text }] }),
        PER_TURN_TIMEOUT_MS,
        prompt.label,
      )
      stopReason = res.stopReason
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
    return {
      label: prompt.label,
      ms: Date.now() - start,
      ...(stopReason === undefined ? {} : { stopReason }),
      ...(error === undefined ? {} : { error }),
      text: client.text(),
      toolCalls: client.toolCalls(),
    }
  }).pipe(
    Effect.tap((result) =>
      Effect.annotateCurrentSpan({
        "firegrid.acp_elicitation.label": result.label,
        "firegrid.acp_elicitation.stop_reason": result.stopReason ?? "",
        "firegrid.acp_elicitation.error": result.error ?? "",
        "firegrid.acp_elicitation.duration_ms": result.ms,
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

export const acpToolElicitationDriver: Effect.Effect<ElicitationResult, unknown> = Effect.gen(
  function*() {
    if (
      globalThis.process.env["ANTHROPIC_API_KEY"] === undefined ||
      globalThis.process.env["ANTHROPIC_API_KEY"] === ""
    ) {
      return yield* Effect.fail(
        new Error(
          "acp-tool-elicitation requires ANTHROPIC_API_KEY in the environment (it drives a real claude-acp agent).",
        ),
      )
    }

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
