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

export interface AgentCodecMeta {
  readonly kind: string
  readonly capabilities: AgentCapabilities
}

export interface AgentSessionService {
  readonly meta: AgentCodecMeta
  /**
   * firegrid-runtime-boundary-reconciliation.CODEC_SESSION.2
   * firegrid-runtime-agent-event-pipeline.STAGES.3-7
   * firegrid-runtime-agent-event-pipeline.STAGES.3-8
   */
  readonly toolUseMode: AgentToolUseMode
  /** Push an input event. The codec encodes and writes to the agent. */
  readonly send: (event: AgentInputEvent) => Effect.Effect<void, AgentCodecError>
  /**
   * Consume output events. The stream completes when the agent
   * terminates or when the codec is interrupted.
   */
  readonly outputs: Stream.Stream<AgentOutputEvent, AgentCodecError>
}

export class AgentSession extends Context.Tag("@firegrid/runtime/AgentSession")<
  AgentSession,
  AgentSessionService
>() {}
