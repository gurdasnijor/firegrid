/**
 * `DurableEventChannel<P>` re-exports from `@firegrid/protocol/channels`.
 *
 * Phase 2 of `SDD_FIREGRID_PROTOCOL_RESPONSE_UNIFICATION` landed
 * `DurableEventChannel<P>` + `EventOffset` in the protocol package as
 * a first-class channel shape. This module re-exports those symbols
 * so the simulation's existing sibling-import path
 * (`./durable-event-channel.ts`) continues to work — and so the
 * simulation continues to serve as the runnable harness verifying
 * that the unified shape covers the product surface.
 *
 * Once Phase 2 completes deletion of the legacy shapes, this file
 * can be removed and all internal sim references can import directly
 * from `@firegrid/protocol/channels`.
 */

export {
  type DurableEventChannel,
  type EventOffset,
  EventOffsetSchema,
  eventOffset,
  makeDurableEventChannel,
} from "@firegrid/protocol/channels"
