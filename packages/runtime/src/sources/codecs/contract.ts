/**
 * Codec contract — protocol-aware scoped session providers between an agent
 * process's duplex byte stream and normalized `AgentInputEvent` /
 * `AgentOutputEvent` channels.
 */

import { Context, Schema, type Effect, type Stream } from "effect"
import type {
  AgentCapabilities,
  AgentInputEvent,
  AgentOutputEvent,
  AgentToolUseMode,
} from "../../events/contract.ts"

/**
 * Error category for codec-level failures: framing errors, protocol
 * violations, capability mismatches, unexpected EOF. The codec is
 * responsible for distinguishing fatal failures (which fail the output
 * Stream with `AgentCodecError`) from recoverable ones (which surface
 * as `Error` output events).
 * firegrid-agent-io-effect-ai-alignment.LOCAL_LIFECYCLE_EVENTS.2
 * firegrid-agent-io-effect-ai-alignment.EFFECT_AI_BOUNDARIES.2
 */
export class AgentCodecError extends Schema.TaggedError<AgentCodecError>()(
  "AgentCodecError",
  {
    codec: Schema.String,
    op: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

interface AgentCodecMeta {
  readonly kind: string
  readonly capabilities: AgentCapabilities
}

/**
 * The discriminant of `AgentInputEvent` — the set of inbound event kinds a
 * codec session may be asked to deliver.
 */
export type AgentInputKind = AgentInputEvent["_tag"]

/**
 * tf-0awo.24 / SDD §3.2 Fix B — typed inbound capability.
 *
 * A session is generic over `K`, the inbound kinds it can actually deliver.
 * `send` only accepts those kinds, so e.g. an ACP session
 * (`AgentSessionService<Exclude<AgentInputKind, "ToolResult">>`) makes
 * `session.send(toolResult)` a COMPILE error — the structural net that stops a
 * provider-owned tool-result relay from being typed into a codec that cannot
 * accept it. `inboundKinds` is the runtime witness of `K`, kept in sync with
 * it, for code paths that erase `K` (the heterogeneous session registry stores
 * `AgentSessionService` with the default `K = AgentInputKind`; the registering
 * adapter consults `inboundKinds` at runtime before dispatching a relay).
 */
export interface AgentSessionService<K extends AgentInputKind = AgentInputKind> {
  readonly meta: AgentCodecMeta
  /**
   * firegrid-runtime-boundary-reconciliation.CODEC_SESSION.2
   * firegrid-runtime-agent-event-pipeline.STAGES.3-7
   * firegrid-runtime-agent-event-pipeline.STAGES.3-8
   */
  readonly toolUseMode: AgentToolUseMode
  /** The inbound kinds this codec can deliver — runtime witness of `K`. */
  readonly inboundKinds: ReadonlySet<K>
  /** Push an input event. The codec encodes and writes to the agent. */
  readonly send: (
    event: Extract<AgentInputEvent, { readonly _tag: K }>,
  ) => Effect.Effect<void, AgentCodecError>
  /**
   * Consume output events. The stream completes when the agent
   * terminates or when the codec is interrupted.
   */
  readonly outputs: Stream.Stream<AgentOutputEvent, AgentCodecError>
}

// The registry Tag erases `K` to the full kind set — sessions of different
// codecs (different `K`) share one Tag; the per-session `inboundKinds` carries
// the real subset for the runtime relay gate.
export class AgentSession extends Context.Tag("@firegrid/runtime/AgentSession")<
  AgentSession,
  AgentSessionService
>() {}
