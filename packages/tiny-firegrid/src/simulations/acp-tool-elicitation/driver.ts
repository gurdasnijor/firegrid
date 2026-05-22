import * as acp from "@agentclientprotocol/sdk"
import { Duration, Effect } from "effect"
import { elicitationHarness } from "./harness.ts"
import { elicitationPrompts, type ElicitationPrompt } from "./prompts.ts"

// Backstop per-turn timeout via Effect's clock (no JS timer): the edge's own
// turnTimeoutMs (30s) usually fires first; this guards a prompt() that never
// settles, and keeps one hung turn from consuming the whole runner budget.
const PER_TURN_TIMEOUT = Duration.seconds(60)

// Abort the matrix walk after this many consecutive provider/timeout failures.
// A single bad provider window (e.g. an Anthropic 529) otherwise starves every
// remaining turn until the runner's global timeout, contaminating the whole
// capture. Two-in-a-row tolerates a one-off blip but bails on a sustained outage.
const ABORT_AFTER_CONSECUTIVE_FAILURES = 2

// How a turn ended, disambiguated from the raw error string so the trace is
// self-explanatory without the edge's (not-yet-merged) typed timeout reasons.
type TurnOutcome =
  | "ok"
  | "empty_end_turn" // settled with end_turn but produced no text and no tool calls
  | "provider_overloaded" // upstream model API 529 / overloaded — not a Firegrid bug
  | "acp_timeout" // edge turn timeout or our PER_TURN_TIMEOUT backstop
  | "internal_error" // agent/edge internal error or non-529 API error
  | "driver_error" // anything else (unexpected client/connection failure)

// Outcomes that signal the agent/provider is unhealthy (vs. doing nothing or
// succeeding). Consecutive runs of these trip the fail-fast.
const FAILURE_OUTCOMES: ReadonlySet<TurnOutcome> = new Set<TurnOutcome>([
  "provider_overloaded",
  "acp_timeout",
  "internal_error",
  "driver_error",
])

interface TurnResult {
  readonly label: string
  readonly outcome: TurnOutcome
  readonly stopReason?: acp.StopReason
  readonly error?: string
  readonly text: string
  readonly toolCalls: ReadonlyArray<string>
}

// Raw turn outcome before classification. Both the success and failure paths of
// runTurn produce this shape; classifyOutcome derives the TurnOutcome from it.
type RawTurn = Omit<TurnResult, "outcome">

const classifyError = (message: string): TurnOutcome => {
  const lower = message.toLowerCase()
  return lower.includes("529") || lower.includes("overload")
    ? "provider_overloaded"
    : lower.includes("timeout")
    ? "acp_timeout"
    : lower.includes("internal error") || lower.includes("api error")
    ? "internal_error"
    : "driver_error"
}

const classifyOutcome = (raw: RawTurn): TurnOutcome =>
  raw.error !== undefined
    ? classifyError(raw.error)
    : raw.stopReason === "end_turn" && raw.text.trim() === "" && raw.toolCalls.length === 0
    ? "empty_end_turn"
    : "ok"

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
    Effect.map((response): RawTurn => ({
      label: prompt.label,
      stopReason: response.stopReason,
      text: client.text(),
      toolCalls: client.toolCalls(),
    })),
    Effect.catchAll((cause) =>
      Effect.succeed<RawTurn>({
        label: prompt.label,
        error: cause instanceof Error ? cause.message : String(cause),
        text: client.text(),
        toolCalls: client.toolCalls(),
      })),
    Effect.map((raw): TurnResult => ({ ...raw, outcome: classifyOutcome(raw) })),
    Effect.tap((result) =>
      Effect.annotateCurrentSpan({
        "firegrid.acp_elicitation.label": result.label,
        "firegrid.acp_elicitation.group": prompt.group,
        "firegrid.acp_elicitation.outcome": result.outcome,
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
  /** Label of the turn after which the walk fail-fast aborted, if any. */
  readonly abortedAfter?: string | undefined
}

// Accumulator for the fail-fast walk: completed turns, the current consecutive
// run of failure outcomes, and the label we bailed after (once tripped).
interface WalkState {
  readonly turns: ReadonlyArray<TurnResult>
  readonly consecutiveFailures: number
  readonly abortedAfter?: string | undefined
}

const initialWalk: WalkState = { turns: [], consecutiveFailures: 0 }

// Walk the prompt matrix in order, one turn at a time. Once a sustained provider
// outage trips the fail-fast, remaining prompts are skipped (not run) so a bad
// window can't drain the whole runner budget.
const walkPrompts = (
  connection: acp.ClientSideConnection,
  sessionId: string,
  client: ElicitationClient,
): Effect.Effect<WalkState, never> =>
  Effect.reduce(elicitationPrompts, initialWalk, (state, prompt) =>
    state.abortedAfter !== undefined
      ? Effect.succeed(state)
      : runTurn(connection, sessionId, prompt, client).pipe(
        Effect.map((result) => {
          const consecutiveFailures = FAILURE_OUTCOMES.has(result.outcome)
            ? state.consecutiveFailures + 1
            : 0
          const tripped = consecutiveFailures >= ABORT_AFTER_CONSECUTIVE_FAILURES
          return {
            turns: [...state.turns, result],
            consecutiveFailures,
            abortedAfter: tripped ? result.label : undefined,
          }
        }),
      ))

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

    const walk = yield* walkPrompts(connection, session.sessionId, client)

    return { sessionId: session.sessionId, turns: walk.turns, abortedAfter: walk.abortedAfter }
  },
).pipe(
  Effect.tap((result) =>
    Effect.annotateCurrentSpan({
      "firegrid.acp_tool_elicitation.acp_session_id": result.sessionId,
      "firegrid.acp_tool_elicitation.turn_count": result.turns.length,
      "firegrid.acp_tool_elicitation.planned_turn_count": elicitationPrompts.length,
      "firegrid.acp_tool_elicitation.error_count": result.turns.filter((t) => t.error !== undefined).length,
      "firegrid.acp_tool_elicitation.aborted": result.abortedAfter !== undefined,
      "firegrid.acp_tool_elicitation.aborted_after": result.abortedAfter ?? "",
    })),
  Effect.withSpan("firegrid.acp_tool_elicitation.driver", {
    kind: "client",
    attributes: { "firegrid.acid": "firegrid-zed-acp-stdio-external-agent.VALIDATION.4" },
  }),
)
