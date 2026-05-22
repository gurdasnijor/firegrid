import { Data } from "effect"

// One shared expected-error type for the prototype subscribers so the composed
// `program` has a single `E` channel and the wiring-check annotations stay
// readable. Production keeps the real per-surface error families
// (RuntimeContextError, AgentCodecError, …); the topology proof only needs the
// `E` channel to be uniform so the spotlight stays on `R`.
export class ProtoRuntimeError extends Data.TaggedError("ProtoRuntimeError")<{
  readonly reason: string
}> {}
