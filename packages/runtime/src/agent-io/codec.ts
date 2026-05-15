/**
 * Codec contract — the protocol-aware layer between an agent process's
 * duplex byte stream and the normalized `AgentInputEvent`/
 * `AgentOutputEvent` channels that `RuntimeContextWorkflow` consumes.
 *
 * Codecs receive Effect AI `Toolkit` metadata directly. Firegrid does not
 * maintain a parallel descriptor/catalog shape for tools.
 */

import type { Toolkit } from "@effect/ai"
import { Schema, type Effect, type Scope, type Stream } from "effect"
import type { AgentInputEvent, AgentOutputEvent, AgentCapabilities } from "./contract.ts"
import type { AgentByteStream } from "./byte-stream.ts"

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

export interface AgentMcpServerDeclaration {
  readonly name: string
  readonly server: {
    readonly type: "url"
    readonly url: string
    readonly headers?: ReadonlyArray<{
      readonly name: string
      readonly value: string
    }>
  }
}

export interface AgentSessionSetupOptions {
  readonly cwd?: string
  readonly mcpServers?: ReadonlyArray<AgentMcpServerDeclaration>
}

export interface AgentCodecOpenOptions {
  // firegrid-agent-io-effect-ai-alignment.TOOLKIT_METADATA.1
  // Optional for V1 codec slices that do not publish a tool catalog;
  // catalog-publishing codecs should treat this as their Effect AI
  // Toolkit source rather than introducing a Firegrid descriptor mirror.
  readonly toolkit?: Toolkit.Any
  readonly session?: AgentSessionSetupOptions
}

export interface AgentSession {
  /** Push an input event. The codec encodes and writes to the agent. */
  readonly send: (event: AgentInputEvent) => Effect.Effect<void, AgentCodecError>
  /**
   * Consume output events. The stream completes when the agent
   * terminates or when the codec is interrupted.
   */
  readonly outputs: Stream.Stream<AgentOutputEvent, AgentCodecError>
}

export interface AgentCodec {
  readonly kind: string
  readonly capabilities: AgentCapabilities
  readonly open: (
    bytes: AgentByteStream,
    options: AgentCodecOpenOptions,
  ) => Effect.Effect<AgentSession, AgentCodecError, Scope.Scope>
}
