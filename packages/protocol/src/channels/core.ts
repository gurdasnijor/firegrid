import { Schema } from "effect"
import type { Effect, Stream } from "effect"

export const ChannelDirectionSchema = Schema.Literal(
  "ingress",
  "egress",
  "call",
  "bidirectional",
)
export type ChannelDirection = Schema.Schema.Type<typeof ChannelDirectionSchema>

export const ChannelSourceClassSchema = Schema.Literal(
  "static-source",
  "predicate-eligible",
)
export type ChannelSourceClass = Schema.Schema.Type<typeof ChannelSourceClassSchema>

export const ChannelTargetSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("ChannelTarget"),
)
export type ChannelTarget = Schema.Schema.Type<typeof ChannelTargetSchema>

export const makeChannelTarget = (target: string): ChannelTarget =>
  Schema.decodeUnknownSync(ChannelTargetSchema)(target)

/**
 * Protocol-owned terminal completion receipt
 * (`SDD_FIREGRID_DURABLE_CHANNELS_SYNC_ASYNC.md` §"Completion Contracts", point
 * 2). A route whose result is terminal completion evidence returns one of these;
 * transport edges (ACP/MCP/CLI/HTTP) project it to their wire response — e.g. an
 * ACP `PromptResponse` + stop reason. Kept transport-neutral: the protocol layer
 * distinguishes the terminal outcome (`Done` / `Rejected`) and carries an
 * optional opaque detail, but does not encode ACP/MCP-specific reason vocab.
 */
export const RouteCompletionReceipt = Schema.Union(
  Schema.TaggedStruct("Done", {
    detail: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("Rejected", {
    reason: Schema.optional(Schema.String),
  }),
)
export type RouteCompletionReceipt = typeof RouteCompletionReceipt.Type

/**
 * Route completion metadata: declares how an edge must read a route's dispatch
 * result, so transports know what invoking the route means before they map the
 * result to a wire response.
 *
 * - `acknowledgement` (default): the dispatch result is an append/identity
 *   receipt, not terminal completion evidence. Edges decode it against the
 *   route's own response schema (the immediate receipt).
 * - `terminal`: the dispatch result IS terminal completion evidence, carried by
 *   `receiptSchema` (typically {@link RouteCompletionReceipt}).
 *
 * This is route-owned descriptor metadata, NOT a call-site sync flag /
 * `isComplete` boolean / await-mode enum. The SDD rejects caller flags because a
 * caller can diverge from the route result and router metadata cannot inspect a
 * caller's flag.
 */
export type ChannelRouteCompletion =
  | { readonly mode: "acknowledgement" }
  | { readonly mode: "terminal"; readonly receiptSchema: Schema.Schema.Any }

export const acknowledgementCompletion: ChannelRouteCompletion = {
  mode: "acknowledgement",
}

export const terminalCompletion = (
  receiptSchema: Schema.Schema.Any = RouteCompletionReceipt,
): ChannelRouteCompletion => ({ mode: "terminal", receiptSchema })

export interface TypedStreamBinding<S extends Schema.Schema.Any = Schema.Schema.Any> {
  readonly _tag: "TypedStream"
  readonly stream: Stream.Stream<Schema.Schema.Type<S>, unknown, never>
}

export interface AppendTargetBinding<
  S extends Schema.Schema.Any = Schema.Schema.Any,
  Receipt = void,
> {
  readonly _tag: "AppendTarget"
  readonly append: (
    payload: Schema.Schema.Type<S>,
  ) => Effect.Effect<Receipt, unknown, never>
}

export interface CallTargetBinding<
  Request extends Schema.Schema.Any = Schema.Schema.Any,
  Response extends Schema.Schema.Any = Schema.Schema.Any,
> {
  readonly _tag: "CallTarget"
  readonly call: (
    request: Schema.Schema.Type<Request>,
  ) => Effect.Effect<Schema.Schema.Type<Response>, unknown, never>
}

export interface IngressChannel<
  S extends Schema.Schema.Any = Schema.Schema.Any,
> {
  readonly target: ChannelTarget
  readonly direction: "ingress"
  readonly schema: S
  readonly sourceClass?: ChannelSourceClass
  readonly completion?: ChannelRouteCompletion
  readonly binding: TypedStreamBinding<S>
}

export interface EgressChannel<
  S extends Schema.Schema.Any = Schema.Schema.Any,
  Receipt = void,
> {
  readonly target: ChannelTarget
  readonly direction: "egress"
  readonly schema: S
  readonly completion?: ChannelRouteCompletion
  readonly binding: AppendTargetBinding<S, Receipt>
}

export interface BidirectionalChannel<
  S extends Schema.Schema.Any = Schema.Schema.Any,
> {
  readonly target: ChannelTarget
  readonly direction: "bidirectional"
  readonly directions: readonly ["ingress", "egress"]
  readonly schema: S
  readonly sourceClasses: ReadonlyArray<ChannelSourceClass>
  readonly completion?: ChannelRouteCompletion
  readonly binding: {
    readonly _tag: "Bidirectional"
    readonly stream: Stream.Stream<Schema.Schema.Type<S>, unknown, never>
    readonly append: (
      payload: Schema.Schema.Type<S>,
    ) => Effect.Effect<void, unknown, never>
  }
}

export interface CallableChannel<
  Request extends Schema.Schema.Any = Schema.Schema.Any,
  Response extends Schema.Schema.Any = Schema.Schema.Any,
> {
  readonly target: ChannelTarget
  readonly direction: "call"
  readonly requestSchema: Request
  readonly responseSchema: Response
  readonly completion?: ChannelRouteCompletion
  readonly binding: CallTargetBinding<Request, Response>
}

export type ChannelRegistration =
  | IngressChannel
  | EgressChannel
  | BidirectionalChannel
  | CallableChannel

export const makeIngressChannel = <S extends Schema.Schema.Any>(
  options: {
    readonly target: ChannelTarget | string
    readonly schema: S
    readonly sourceClass?: ChannelSourceClass
    readonly completion?: ChannelRouteCompletion
    readonly stream: Stream.Stream<Schema.Schema.Type<S>, unknown, never>
  },
): IngressChannel<S> => ({
  target: typeof options.target === "string"
    ? makeChannelTarget(options.target)
    : options.target,
  direction: "ingress",
  schema: options.schema,
  ...(options.sourceClass === undefined
    ? {}
    : { sourceClass: options.sourceClass }),
  ...(options.completion === undefined
    ? {}
    : { completion: options.completion }),
  binding: {
    _tag: "TypedStream",
    stream: options.stream,
  },
})

export const makeEgressChannel = <S extends Schema.Schema.Any, Receipt = void>(
  options: {
    readonly target: ChannelTarget | string
    readonly schema: S
    readonly completion?: ChannelRouteCompletion
    readonly append: (
      payload: Schema.Schema.Type<S>,
    ) => Effect.Effect<Receipt, unknown, never>
  },
): EgressChannel<S, Receipt> => ({
  target: typeof options.target === "string"
    ? makeChannelTarget(options.target)
    : options.target,
  direction: "egress",
  schema: options.schema,
  ...(options.completion === undefined
    ? {}
    : { completion: options.completion }),
  binding: {
    _tag: "AppendTarget",
    append: options.append,
  },
})

export const makeBidirectionalChannel = <S extends Schema.Schema.Any>(
  options: {
    readonly target: ChannelTarget | string
    readonly schema: S
    readonly sourceClasses: ReadonlyArray<ChannelSourceClass>
    readonly completion?: ChannelRouteCompletion
    readonly stream: Stream.Stream<Schema.Schema.Type<S>, unknown, never>
    readonly append: (
      payload: Schema.Schema.Type<S>,
    ) => Effect.Effect<void, unknown, never>
  },
): BidirectionalChannel<S> => ({
  target: typeof options.target === "string"
    ? makeChannelTarget(options.target)
    : options.target,
  direction: "bidirectional",
  directions: ["ingress", "egress"],
  schema: options.schema,
  sourceClasses: options.sourceClasses,
  ...(options.completion === undefined
    ? {}
    : { completion: options.completion }),
  binding: {
    _tag: "Bidirectional",
    stream: options.stream,
    append: options.append,
  },
})

export const makeCallableChannel = <
  Request extends Schema.Schema.Any,
  Response extends Schema.Schema.Any,
>(
  options: {
    readonly target: ChannelTarget | string
    readonly requestSchema: Request
    readonly responseSchema: Response
    readonly completion?: ChannelRouteCompletion
    readonly call: (
      request: Schema.Schema.Type<Request>,
    ) => Effect.Effect<Schema.Schema.Type<Response>, unknown, never>
  },
): CallableChannel<Request, Response> => ({
  target: typeof options.target === "string"
    ? makeChannelTarget(options.target)
    : options.target,
  direction: "call",
  requestSchema: options.requestSchema,
  responseSchema: options.responseSchema,
  ...(options.completion === undefined
    ? {}
    : { completion: options.completion }),
  binding: {
    _tag: "CallTarget",
    call: options.call,
  },
})

// ── DurableEventChannel<P> — unified durable-event append shape ─────────────
//
// Per `docs/sdds/SDD_FIREGRID_PROTOCOL_RESPONSE_UNIFICATION.md`. Every
// input-delivery operation in firegrid (prompt, permission response,
// session start, tool dispatch, scheduled fire, webhook ingest, peer
// emit) is the same operation: durably append an event to a
// consumer's stream and return a stable offset. Under the unified
// abstraction these are all `DurableEventChannel<P>` parameterized
// by payload — one shape instead of seven specialized response
// schemas.
//
// The historical response shapes (`RuntimeInputIntentRow`,
// `PermissionRespondOutput`, `RuntimeStartRequestAck`, ...) collapse
// to `EventOffset` — the wire-level append receipt, deduplicated at
// the durable-streams `Producer-Seq` layer.

/**
 * Wire-level append receipt. `offset` is an opaque, lexicographically
 * sortable position identifier. `deduplicated` is optional: when
 * present it surfaces the durable-streams Producer-Seq dedup outcome
 * (true if this append was server-side deduped). The schema
 * deliberately carries NO application-shaped fields (no `inputId`,
 * `requestId`, `inserted` boolean, `contextId`). Application
 * correlation lives in the payload; lifecycle lives in the consumer.
 */
export const EventOffsetSchema = Schema.Struct({
  offset: Schema.String,
  deduplicated: Schema.optional(Schema.Boolean),
})
export type EventOffset = Schema.Schema.Type<typeof EventOffsetSchema>

/**
 * `DurableEventChannel<P>` is structurally `EgressChannel<P, EventOffset>`.
 * Egress direction already encodes "producer appends, consumer reads
 * downstream"; the new shape just standardizes the Receipt type to
 * `EventOffset` so producers ignore application-level row schemas at
 * the channel boundary.
 */
export type DurableEventChannel<P extends Schema.Schema.Any> = EgressChannel<P, EventOffset>

export const makeDurableEventChannel = <P extends Schema.Schema.Any>(
  options: {
    readonly target: ChannelTarget | string
    readonly schema: P
    readonly append: (
      payload: Schema.Schema.Type<P>,
    ) => Effect.Effect<EventOffset, unknown, never>
  },
): DurableEventChannel<P> =>
  makeEgressChannel({
    target: typeof options.target === "string"
      ? makeChannelTarget(options.target)
      : options.target,
    schema: options.schema,
    append: options.append,
  })

/**
 * Construct an `EventOffset` from a stable string identifier
 * (typically a durable-streams wire offset, or a stable application-
 * derived key during the simulation phase before wire offsets are
 * available to the binding).
 */
export const eventOffset = (
  offset: string,
  options?: { readonly deduplicated?: boolean },
): EventOffset =>
  options?.deduplicated === undefined
    ? { offset }
    : { offset, deduplicated: options.deduplicated }
