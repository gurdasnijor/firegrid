import type {
  AgentCodecError,
  AgentSessionService,
} from "@firegrid/runtime/codecs"
import type {
  AgentInputEvent,
  AgentOutputEvent,
} from "@firegrid/runtime/events"
import type { Effect, Stream } from "effect"

interface TinyCodecBoundary {
  readonly send: (event: AgentInputEvent) => Effect.Effect<void, AgentCodecError>
  readonly outputs: Stream.Stream<AgentOutputEvent, AgentCodecError>
}

export const codecBoundaryFromSession = (
  session: AgentSessionService,
): TinyCodecBoundary => ({
  send: session.send,
  outputs: session.outputs,
})
