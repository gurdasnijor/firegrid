// Shape C Wave C — channel/router thesis protocol primitives (sim-local).
//
// These types mirror the production primitives in
// `packages/protocol/src/channels/core.ts` and the SDD shape in
// `docs/sdds/SDD_FIREGRID_HOST_PLANE_CHANNEL_ROUTER.md`. They are
// re-declared here in tiny-firegrid so the simulation stands or falls on
// the SHAPE the SDD pins, not on whether the production helpers already
// exist.
//
// Vocabulary kept verbatim from the SDD / cannon docs:
//   - `ChannelTarget` (branded string)
//   - `ChannelDirection` ∈ "ingress" | "egress" | "call" | "bidirectional"
//   - direction → verb matrix:
//       ingress       → wait_for (typed Stream of observations)
//       egress        → send     (durable append / request sentinel)
//       call          → call     (durable request/response handshake)
//       bidirectional → send + wait_for
//   - `ChannelRoute` carries (contract + live + projection metadata)
//   - `ChannelRouter<Routes>` has `{ routes, dispatch }` where `dispatch`
//     is the string-keyed edge view derived from `routes`.
//   - Completion is route-owned: `acknowledgement` (immediate receipt) or
//     `terminal` (the dispatch result IS terminal completion evidence).
//   - `RouteCompletionReceipt` union of `Done` / `Rejected` — protocol-
//     neutral terminal evidence the SDD specifies.

import { Brand, type Effect, Schema, type Stream } from "effect"

// ── Direction + target ────────────────────────────────────────────────────

export type ChannelDirection =
  | "ingress"
  | "egress"
  | "call"
  | "bidirectional"

export type ChannelTarget = string & Brand.Brand<"ChannelTarget">
export const ChannelTarget = Brand.nominal<ChannelTarget>()

// ── Route completion (protocol-neutral terminal evidence) ─────────────────

export const RouteCompletionReceiptSchema = Schema.Union(
  Schema.TaggedStruct("Done", {
    detail: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("Rejected", {
    reason: Schema.optional(Schema.String),
  }),
)
export type RouteCompletionReceipt = Schema.Schema.Type<typeof RouteCompletionReceiptSchema>

export type ChannelRouteCompletion =
  | { readonly mode: "acknowledgement" }
  | { readonly mode: "terminal"; readonly receiptSchema: Schema.Schema.AnyNoContext }

export const acknowledgementCompletion: ChannelRouteCompletion = {
  mode: "acknowledgement",
}

export const terminalCompletion = (
  receiptSchema: Schema.Schema.AnyNoContext = RouteCompletionReceiptSchema,
): ChannelRouteCompletion => ({ mode: "terminal", receiptSchema })

// ── Direction-specific bindings (the runtime live half) ───────────────────

export interface TypedStreamBinding<S extends Schema.Schema.AnyNoContext> {
  readonly _tag: "TypedStream"
  readonly stream: (
    input: Schema.Schema.Type<S>,
  ) => Stream.Stream<unknown, unknown, never>
}

export interface AppendTargetBinding<S extends Schema.Schema.AnyNoContext, Receipt> {
  readonly _tag: "AppendTarget"
  readonly append: (
    payload: Schema.Schema.Type<S>,
  ) => Effect.Effect<Receipt, unknown, never>
}

export interface CallTargetBinding<
  Request extends Schema.Schema.AnyNoContext,
  Response extends Schema.Schema.AnyNoContext,
> {
  readonly _tag: "CallTarget"
  readonly call: (
    request: Schema.Schema.Type<Request>,
  ) => Effect.Effect<Schema.Schema.Type<Response>, unknown, never>
}

// ── Channel contracts (per-direction descriptors) ─────────────────────────

export interface IngressChannel<S extends Schema.Schema.AnyNoContext> {
  readonly target: ChannelTarget
  readonly direction: "ingress"
  readonly inputSchema: S
  readonly observationSchema: Schema.Schema.AnyNoContext
  readonly completion?: ChannelRouteCompletion
  readonly binding: TypedStreamBinding<S>
}

export interface EgressChannel<S extends Schema.Schema.AnyNoContext, Receipt> {
  readonly target: ChannelTarget
  readonly direction: "egress"
  readonly inputSchema: S
  readonly responseSchema: Schema.Schema.AnyNoContext
  readonly completion: ChannelRouteCompletion
  readonly binding: AppendTargetBinding<S, Receipt>
}

export interface CallableChannel<
  Request extends Schema.Schema.AnyNoContext,
  Response extends Schema.Schema.AnyNoContext,
> {
  readonly target: ChannelTarget
  readonly direction: "call"
  readonly inputSchema: Request
  readonly responseSchema: Response
  readonly completion: ChannelRouteCompletion
  readonly binding: CallTargetBinding<Request, Response>
}

export type ChannelContract =
  | IngressChannel<Schema.Schema.AnyNoContext>
  | EgressChannel<Schema.Schema.AnyNoContext, unknown>
  | CallableChannel<Schema.Schema.AnyNoContext, Schema.Schema.AnyNoContext>

// ── Route descriptor (the router-entry shape) ─────────────────────────────

export interface ChannelRoute<C extends ChannelContract = ChannelContract> {
  readonly contract: C
  /** Human-facing description for edge projection (per SDD §Acceptance). */
  readonly description: string
}

export const ingressRoute = <S extends Schema.Schema.AnyNoContext>(
  contract: IngressChannel<S>,
  description: string,
): ChannelRoute<IngressChannel<S>> => ({ contract, description })

export const egressRoute = <S extends Schema.Schema.AnyNoContext, Receipt>(
  contract: EgressChannel<S, Receipt>,
  description: string,
): ChannelRoute<EgressChannel<S, Receipt>> => ({ contract, description })

export const callableRoute = <
  Req extends Schema.Schema.AnyNoContext,
  Res extends Schema.Schema.AnyNoContext,
>(
  contract: CallableChannel<Req, Res>,
  description: string,
): ChannelRoute<CallableChannel<Req, Res>> => ({ contract, description })

// ── Errors ────────────────────────────────────────────────────────────────

export class ChannelRouteNotFound extends Schema.TaggedError<ChannelRouteNotFound>()(
  "ChannelRouteNotFound",
  { target: Schema.String },
) {}

export class ChannelRouteVerbNotSupported extends Schema.TaggedError<ChannelRouteVerbNotSupported>()(
  "ChannelRouteVerbNotSupported",
  {
    target: Schema.String,
    direction: Schema.String,
    verb: Schema.String,
  },
) {}

export type ChannelRouteError =
  | ChannelRouteNotFound
  | ChannelRouteVerbNotSupported
