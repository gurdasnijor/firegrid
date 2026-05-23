// Pure output-row decoder re-export.
//
// Logical pipeline position: transforms/ (peer of producers, channels).
// Pure: no Effect, no Layer, no Context.Tag, no I/O.
//
// The canonical implementation lives in `@firegrid/protocol/session-facade`
// (`runtimeAgentOutputObservationFromRow`) — it is an `Option`-returning pure
// projection of `RuntimeEventRow` to `RuntimeAgentOutputObservation`. This
// module exposes it under the Shape C cutover semantic path
// (docs/architecture/2026-05-22-runtime-physical-target-tree.md
// §"Target Tree"). The existing `events/output.ts`
// re-export keeps working until callers migrate.

export {
  runtimeAgentOutputObservationFromRow,
} from "@firegrid/protocol/session-facade"
