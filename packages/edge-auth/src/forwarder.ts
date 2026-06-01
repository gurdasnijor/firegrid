/**
 * The durable-streams forwarder seam.
 *
 * The resolver authorizes `(handle, verb)` and resolves an opaque handle to a
 * concrete stream NAME; this service is the only thing that turns a stream
 * name into an actual durable-streams request. Keeping it behind a `Context`
 * tag does two things:
 *
 *  1. It is the airgap boundary in code — the resolver hands a resolved stream
 *     name + the client's bytes to `append`/`read`/`head`; nothing above this
 *     seam ever holds a durable-streams URL or the host's DS credentials.
 *  2. It makes the whole auth path testable against an in-memory double
 *     (`@firegrid/edge-auth/testkit`) without standing up a live
 *     durable-streams server — the validation substrate for tf-r06u.33.
 *
 * The PRODUCTION layer (a real reverse-proxy against durable-streams' HTTP
 * surface, injecting the host DS Bearer and stripping the client token) is the
 * deferred-productionization point of this slice's confirmed scope (Core +
 * thin HttpApi binding; TLS/deploy deferred). It composes `effect-durable-
 * streams` `Reader`/`Writer` behind this exact interface.
 */
import { Context, Data, type Effect, type Option } from "effect"

/** A transport-level failure forwarding to durable-streams. */
export class ForwardError extends Data.TaggedError("edge-auth/ForwardError")<{
  readonly streamName: string
  readonly detail?: string
}> {}

/**
 * Retention trimmed past the requested offset — durable-streams `410 Gone`
 * (PROTOCOL §5.6). Surfaced as its own error so the binding can map it to a
 * `410` the edge treats as "resync from a fresh handle" (consumer-contract
 * §5.2), not a fatal error. The richer resync entry point is tf-r06u.43.
 */
export class ForwardGone extends Data.TaggedError("edge-auth/ForwardGone")<{
  readonly streamName: string
}> {}

export interface ForwardAppendResult {
  /** durable-streams `Stream-Next-Offset` after the append. */
  readonly offset: string
  /** True when the producer-fence deduplicated this append (PROTOCOL §5.2.1). */
  readonly deduplicated: boolean
}

export interface ForwardReadResult {
  /** The raw event payloads in this catch-up page, in stream order. */
  readonly events: ReadonlyArray<unknown>
  /** The cursor to pass as `?offset=` on the next poll (`Stream-Next-Offset`). */
  readonly nextOffset: string
  /** True when the read caught up to the stream head (`Stream-Up-To-Date`). */
  readonly upToDate: boolean
}

/**
 * Optional producer-fence coordinates the edge supplies on append for
 * end-to-end idempotency (PROTOCOL §5.2.1). The resolver passes them through
 * verbatim — it does not interpret the intent payload (that is the host
 * intent-observer's job, tf-r06u.42); this layer stays a pure auth+transport
 * proxy, never a gateway.
 */
export interface ForwardProducer {
  readonly id: string
  readonly epoch: number
  readonly seq: number
}

export class DurableStreamsForwarder extends Context.Tag(
  "edge-auth/DurableStreamsForwarder",
)<
  DurableStreamsForwarder,
  {
    readonly head: (
      streamName: string,
    ) => Effect.Effect<Option.Option<string>, ForwardError>
    readonly append: (
      streamName: string,
      body: unknown,
      producer?: ForwardProducer,
    ) => Effect.Effect<ForwardAppendResult, ForwardError>
    readonly read: (
      streamName: string,
      offset: Option.Option<string>,
    ) => Effect.Effect<ForwardReadResult, ForwardError | ForwardGone>
  }
>() {}
