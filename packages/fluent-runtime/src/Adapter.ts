/**
 * The per-harness **adapter contract** for the non-invasive agent binding
 * (SDD `fluent-firegrid-sdd.md` Appendix E; design reference:
 * `repos/durable-streams/packages/coding-agents/src/adapters/types.ts`).
 *
 * The agent keeps its OWN native/ACP harness loop. The adapter only binds I/O —
 * it spawns the harness, observes raw output, forwards translated intents, and
 * prepares a native resume artifact from durable history. Firegrid never owns
 * the reasoning loop.
 */

/** The harnesses the binding supports (extend per adapter). */
export type AgentType = "claude" | "codex"

/** A user identity attached to client-authored intents. */
export interface User {
  readonly name: string
  readonly email: string
}

/**
 * A durable client intent — what a client appends to the session stream. The
 * bridge (not the client) decides what actually reaches the harness.
 */
export type ClientIntent =
  | { readonly type: "user_message"; readonly text: string; readonly syntheticKey?: string }
  | { readonly type: "control_response"; readonly response: ControlResponsePayload }
  | { readonly type: "interrupt" }

export interface ControlResponsePayload {
  readonly request_id: string | number
  readonly subtype: "success" | "cancelled"
  readonly response: object
}

/** How a raw harness message is classified (drives mediation + dedup). */
export interface MessageClassification {
  readonly type: "request" | "response" | "notification"
  readonly id?: string | number
}

export interface SpawnOptions {
  readonly cwd: string
  readonly rewritePaths?: Record<string, string>
  readonly model?: string
  /** A native resume id recovered by `prepareResume` (omitted = fresh session). */
  readonly resume?: string
  readonly forceSeedWorkspace?: boolean
  readonly resumeTranscriptSourcePath?: string
  readonly env?: Record<string, string>
}

/** Options for reconstructing a native resume artifact from durable history. */
export interface ResumeOptions {
  readonly cwd: string
  readonly rewritePaths?: Record<string, string>
}

/**
 * The native resume artifact `prepareResume` reconstructs from the durable
 * stream. `resumeId` absent ⇒ no reconstructable native state (caller must
 * decide fresh-spawn vs fail; see fluent-native-resume.feature).
 */
export interface PreparedResume {
  readonly resumeId?: string
  readonly forceSeedWorkspace?: boolean
  readonly resumeTranscriptSourcePath?: string
}

/** A raw stream envelope (the durable truth) as seen by `prepareResume`. */
export interface StreamEnvelope {
  readonly direction: "user" | "agent" | "bridge"
  readonly raw: unknown
}

/** A live connection to a spawned harness — push-based I/O. */
export interface AgentConnection {
  /** Observe raw harness output (recorded to the stream BEFORE any projection). */
  readonly onMessage: (handler: (raw: object) => void) => void
  /** Forward a translated native intent to the harness. */
  readonly send: (raw: object) => void
  /** Terminate the harness. */
  readonly kill: () => void
  /** Observe harness exit (→ durable lifecycle `session_ended`). */
  readonly on: (event: "exit", handler: (code: number | null) => void) => void
}

/**
 * The per-harness adapter. A new harness is supported by adding an adapter —
 * never by teaching the bridge the harness's internal loop.
 */
export interface AgentAdapter {
  readonly agentType: AgentType
  /** Start the agent's NATIVE harness process. */
  readonly spawn: (options: SpawnOptions) => Promise<AgentConnection>
  /** Classify a raw message as request/response/notification (+ correlation id). */
  readonly parseDirection: (raw: object) => MessageClassification
  /** Detect the harness's native turn-terminal signal (Claude `result` / Codex `turn/completed`). */
  readonly isTurnComplete: (raw: object) => boolean
  /** Map a durable client intent to the harness's native message shape (per-request fidelity). */
  readonly translateClientIntent: (intent: ClientIntent, user?: User) => object
  /** Reconstruct a native resume artifact from durable history (see Resume / E.5). */
  readonly prepareResume: (
    history: ReadonlyArray<StreamEnvelope>,
    options: ResumeOptions,
  ) => Promise<PreparedResume>
  /**
   * Park interface, mechanism (b) — produce the harness's NATIVE run-terminating
   * tool result for a parking tool call: a result the harness treats as ENDING
   * its current turn (transport end-of-turn). Its presence is what makes a
   * durable wait a substrate guarantee rather than relying on the model to stop
   * (mechanism (a)). A harness whose transport offers no such result cannot prove
   * the park interface (see fluent-park-interface.feature). Optional per harness.
   */
  readonly runTerminatingToolResult?: (toolCallId: string) => object
}
