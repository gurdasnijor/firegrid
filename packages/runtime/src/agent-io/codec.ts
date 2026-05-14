/**
 * Codec contract — the protocol-aware layer between an agent process's
 * duplex byte stream and the normalized `AgentInputEvent`/
 * `AgentOutputEvent` channels that `RuntimeContextWorkflow` consumes.
 *
 * Phase 1 PR 1 defines the interface only. Concrete codecs
 * (`StdioJsonlCodec`, `AcpCodec`) land in subsequent PRs.
 */

import { Schema, type Effect, type Scope, type Stream } from "effect"
import type { AgentInputEvent, AgentOutputEvent, AgentCapabilities } from "./contract.ts"
import type { AgentByteStream } from "./byte-stream.ts"
import type { AgentToolDescriptor } from "./descriptor.ts"

/**
 * Error category for codec-level failures: framing errors, protocol
 * violations, capability mismatches, unexpected EOF. The codec is
 * responsible for distinguishing fatal failures (which fail the output
 * Stream with `AgentCodecError`) from recoverable ones (which surface
 * as `Error` output events).
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

export interface AgentCodecOpenOptions {
  readonly toolCatalog: ReadonlyArray<AgentToolDescriptor<unknown, unknown>>
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
