// producers/ — Shape A live boundaries: scoped, live, no durable plane.
//
// `AgentSession` is the live agent connection (send input / observe output).
// In production its layers are `AcpSessionLive` / `StdioJsonlSessionLive`, built
// over an `AgentByteStream` from a sandbox provider. A Shape A component's `R`
// is only transport/session/id tags — if it ever needs `DurableTable`, runtime
// state, or workflow machinery, it has crossed out of Shape A.

import { Context, Effect, Layer, Stream } from "effect"
import type { RuntimeAgentOutputObservation } from "../events/index.ts"
import type { ProtoRuntimeError } from "../errors.ts"

export interface AgentInput {
  readonly contextId: string
  readonly text: string
}

export interface AgentSessionService {
  readonly send: (input: AgentInput) => Effect.Effect<void, ProtoRuntimeError>
  readonly outputs: Stream.Stream<RuntimeAgentOutputObservation, ProtoRuntimeError>
}

export class AgentSession extends Context.Tag(
  "@proto/target-topology/AgentSession",
)<AgentSession, AgentSessionService>() {}

export const AgentSessionStubLayer: Layer.Layer<AgentSession> = Layer.succeed(
  AgentSession,
  {
    send: () => Effect.void,
    outputs: Stream.empty,
  },
)
