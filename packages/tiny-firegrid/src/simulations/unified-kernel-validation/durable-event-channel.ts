/**
 * `DurableEventChannel<P>` — the unified channel shape proposed in
 * `docs/sdds/SDD_FIREGRID_PROTOCOL_RESPONSE_UNIFICATION.md`.
 *
 * Every input-delivery operation in firegrid (prompt, permission
 * response, session start, tool dispatch, scheduled fire, webhook
 * ingest, peer emit) is the same shape: durably append an event to
 * a consumer's stream and return a stable offset. Under the unified
 * abstraction this is ONE channel type parameterized by payload.
 *
 * The historical specialized response shapes (RuntimeInputIntentRow,
 * PermissionRespondOutput, RuntimeStartRequestAck, ...) collapse to
 * `EventOffset` — a wire-level position receipt, deduplicated at the
 * durable-streams Producer-Seq layer.
 *
 * Phase 1 (this file): live in the simulation as the target shape.
 * Phase 2: this code moves into `@firegrid/protocol/channels/core.ts`
 * and the seven specialized response schemas are deleted in one cut.
 */

import {
  type ChannelTarget,
  type EgressChannel,
  makeEgressChannel,
  makeChannelTarget,
} from "@firegrid/protocol/channels"
import { type Effect, Schema } from "effect"

// ── EventOffset ─────────────────────────────────────────────────────────────

/**
 * Wire-level append receipt. `offset` is an opaque, lexicographically
 * sortable position identifier — clients use it to resume reads from
 * exactly that point. `deduplicated` is optional: when present it
 * surfaces the durable-streams Producer-Seq dedup outcome (true if
 * this append was server-side deduped because a prior append with the
 * same Producer-Id + Producer-Seq already succeeded).
 *
 * The schema deliberately does NOT carry application-shaped fields
 * (no inputId, no requestId, no inserted boolean, no contextId).
 * Application correlation lives in the payload; lifecycle lives in
 * the consumer (the workflow body that processes the event).
 */
export const EventOffsetSchema = Schema.Struct({
  offset: Schema.String,
  deduplicated: Schema.optional(Schema.Boolean),
})
export type EventOffset = Schema.Schema.Type<typeof EventOffsetSchema>

/**
 * `DurableEventChannel<P>` is structurally an `EgressChannel<P, EventOffset>`.
 * The egress direction already encodes "producer appends, consumer
 * reads downstream" — the new shape just standardizes the Receipt
 * type to `EventOffset` and lets callers ignore application-level
 * row schemas at the channel boundary.
 *
 * Naming kept compatible with the existing channel taxonomy so the
 * phase-2 cutover is a rename + reuse, not a re-engineering.
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

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Construct an `EventOffset` from a stable string identifier (typically
 * the signal key under the simulation, or a durable-streams wire offset
 * once we have access to the underlying append result). `deduplicated`
 * is left undefined when not observable at the application layer.
 */
export const eventOffset = (
  offset: string,
  options?: { readonly deduplicated?: boolean },
): EventOffset =>
  options?.deduplicated === undefined
    ? { offset }
    : { offset, deduplicated: options.deduplicated }
