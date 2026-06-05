/**
 * The generic non-invasive **bridge** between durable client intents and an
 * agent's own native/ACP harness (SDD Appendix E; design reference:
 * `repos/durable-streams/packages/coding-agents/src/bridge.ts`).
 *
 * The bridge is adapter-agnostic. It:
 *  - records raw harness output to the stream BEFORE deriving any projection
 *    (raw is the durable truth);
 *  - emits durable lifecycle envelopes (`session_started`/`resumed`/`ended`);
 *  - serializes prompts — one in flight at a time, the next forwarded only after
 *    the adapter observes the harness's native turn-complete;
 *  - dedups duplicate responses for a pending request id (at-most-once);
 *  - on `interrupt`, synthesizes cancellation responses for all pending requests
 *    BEFORE the native interrupt (terminal signal recorded before cleanup);
 *  - on (re)start with history, reconstructs the native resume artifact via the
 *    adapter and resumes natively, replaying unfinished prompts.
 *
 * Dependencies are injected (recorder, history, spawn options) so the mediation
 * logic is unit-testable with a fake adapter BELOW the acceptance layer. A fake
 * adapter is NEVER acceptance proof — see fluent-agent-adapter-contract.feature.
 */
import type {
  AgentAdapter,
  AgentConnection,
  ClientIntent,
  ControlResponsePayload,
  SpawnOptions,
  StreamEnvelope,
  User,
} from "./Adapter.ts"

export type BridgeLifecycle =
  | { readonly type: "session_started" }
  | { readonly type: "session_resumed"; readonly resumeId: string }
  | { readonly type: "session_ended"; readonly code: number | null }
  | { readonly type: "resume_fallback"; readonly reason: string }

export interface BridgeDeps {
  /** Append an envelope to the session stream (raw=truth, recorded immediately). */
  readonly recordEnvelope: (envelope: StreamEnvelope) => void
  /** Prior stream history; non-empty drives native resume. `[]` = fresh session. */
  readonly history?: ReadonlyArray<StreamEnvelope>
  /** Base spawn options (cwd, env, …); resume fields are filled by the bridge. */
  readonly spawnOptions: SpawnOptions
  readonly user?: User
}

export interface Bridge {
  /** Spawn (or resume) the harness, wire I/O, replay unfinished prompts. */
  readonly start: () => Promise<void>
  /** Enqueue a user prompt (forwarded when no turn is in flight). */
  readonly prompt: (text: string) => void
  /** Forward a control response (deduped per pending request id). */
  readonly respond: (response: ControlResponsePayload) => void
  /** Synthesize cancellations for pending requests, then native interrupt. */
  readonly interrupt: () => void
  /** Terminate the harness. */
  readonly kill: () => void
}

const isUserMessage = (
  raw: unknown,
): raw is Extract<ClientIntent, { type: "user_message" }> =>
  typeof raw === "object" && raw !== null && (raw as { type?: unknown }).type === "user_message"

/**
 * Unfinished prompts to replay on resume: each `user_message` is "open" until a
 * native turn-complete closes it (mirrors coding-agents `buildPendingPromptIntents`).
 */
const pendingPromptsFromHistory = (
  history: ReadonlyArray<StreamEnvelope>,
  adapter: AgentAdapter,
): Array<Extract<ClientIntent, { type: "user_message" }>> =>
  history.reduce<Array<Extract<ClientIntent, { type: "user_message" }>>>(
    (pending, envelope) => {
      if (envelope.direction === "user" && isUserMessage(envelope.raw)) {
        pending.push(envelope.raw)
      } else if (
        envelope.direction === "agent" &&
        typeof envelope.raw === "object" && envelope.raw !== null &&
        adapter.isTurnComplete(envelope.raw)
      ) {
        pending.shift()
      }
      return pending
    },
    [],
  )

export const createBridge = (
  adapter: AgentAdapter,
  deps: BridgeDeps,
): Bridge => {
  const history = deps.history ?? []
  const promptQueue: Array<ClientIntent> = []
  const pendingAgentRequests = new Map<string | number, object>()
  const forwardedResponseKeys = new Set<string>()
  let connection: AgentConnection | undefined
  let turnInProgress = false

  const record = (direction: StreamEnvelope["direction"], raw: unknown): void => {
    deps.recordEnvelope({ direction, raw })
  }

  const forward = (intent: ClientIntent): void => {
    connection?.send(adapter.translateClientIntent(intent, deps.user))
  }

  const processQueue = (): void => {
    if (turnInProgress || connection === undefined || promptQueue.length === 0) return
    const intent = promptQueue.shift()
    if (intent === undefined) return
    turnInProgress = true
    record("user", intent) // intent is durable
    forward(intent)
  }

  const wire = (conn: AgentConnection): void => {
    conn.onMessage((raw) => {
      // Record the raw harness message FIRST — it is the durable truth, recorded
      // before any classification/projection is derived from it.
      record("agent", raw)
      const classification = adapter.parseDirection(raw)
      if (classification.id !== undefined) {
        if (classification.type === "request") pendingAgentRequests.set(classification.id, raw)
        if (classification.type === "response") pendingAgentRequests.delete(classification.id)
      }
      if (adapter.isTurnComplete(raw)) {
        turnInProgress = false
        processQueue()
      }
    })
    conn.on("exit", (code) => {
      // A dead harness becomes durable lifecycle state — never silently dropped.
      record("bridge", { type: "session_ended", code } satisfies BridgeLifecycle)
    })
  }

  const start = async (): Promise<void> => {
    const hasHistory = history.length > 0
    let resumeId: string | undefined
    let forceSeedWorkspace = false
    let resumeTranscriptSourcePath: string | undefined
    if (hasHistory) {
      const prepared = await adapter.prepareResume(history, {
        cwd: deps.spawnOptions.cwd,
        ...(deps.spawnOptions.rewritePaths === undefined
          ? {}
          : { rewritePaths: deps.spawnOptions.rewritePaths }),
      })
      resumeId = prepared.resumeId
      forceSeedWorkspace = prepared.forceSeedWorkspace ?? false
      resumeTranscriptSourcePath = prepared.resumeTranscriptSourcePath
    }
    const pending = pendingPromptsFromHistory(history, adapter)

    const open = (resumeValue: string | undefined): Promise<AgentConnection> =>
      adapter.spawn({
        ...deps.spawnOptions,
        ...(resumeValue === undefined ? {} : { resume: resumeValue }),
        ...(forceSeedWorkspace ? { forceSeedWorkspace } : {}),
        ...(resumeTranscriptSourcePath === undefined ? {} : { resumeTranscriptSourcePath }),
      })

    let resumed = false
    try {
      connection = await open(resumeId)
      resumed = resumeId !== undefined
    } catch (error) {
      // Fresh-spawn fallback is allowed ONLY when a resume id was recovered and
      // there are pending prompts to bridge the gap; otherwise propagate.
      if (resumeId === undefined || pending.length === 0) throw error
      connection = await open(undefined)
      record("bridge", {
        type: "resume_fallback",
        reason: error instanceof Error ? error.message : String(error),
      } satisfies BridgeLifecycle)
    }

    wire(connection)
    record(
      "bridge",
      resumed
        ? ({ type: "session_resumed", resumeId: resumeId as string } satisfies BridgeLifecycle)
        : ({ type: "session_started" } satisfies BridgeLifecycle),
    )

    promptQueue.push(...pending)
    processQueue()
  }

  const prompt = (text: string): void => {
    promptQueue.push({ type: "user_message", text })
    processQueue()
  }

  const respond = (response: ControlResponsePayload): void => {
    const key = `response:${String(response.request_id)}`
    if (forwardedResponseKeys.has(key)) return // at-most-once per pending request id
    forwardedResponseKeys.add(key)
    pendingAgentRequests.delete(response.request_id)
    const intent: ClientIntent = { type: "control_response", response }
    record("user", intent)
    forward(intent)
  }

  const interrupt = (): void => {
    Array.from(pendingAgentRequests.keys()).forEach((requestId) => {
      const cancellation: ClientIntent = {
        type: "control_response",
        response: { request_id: requestId, subtype: "cancelled", response: {} },
      }
      record("user", cancellation) // cancellations recorded BEFORE the native interrupt
      forward(cancellation)
    })
    pendingAgentRequests.clear()
    forward({ type: "interrupt" })
  }

  const kill = (): void => {
    connection?.kill()
  }

  return { start, prompt, respond, interrupt, kill }
}
