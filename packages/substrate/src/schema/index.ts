// durable-records-and-projections.RECORDS.6
// durable-records-and-projections.RECORDS.7
// durable-records-and-projections.RECORDS.8
// durable-records-and-projections.RECORDS.9
// durable-records-and-projections.SCHEMA_LAYOUT.1
// durable-records-and-projections.SUBSTRATE_SCOPE.6
// durable-records-and-projections.SUBSTRATE_SCOPE.7
// ready-work-projection.READY_WORK_PROJECTION.7
//
// Canonical substrate schema modules. Row schemas, the durable-streams
// state schema, and the ready-work projection-output contract live
// here so the substrate's authoritative type definitions are easy to
// discover at one canonical location. Logic that consumes these
// schemas (state-machine, projection derivations) stays in its own
// modules.

export * from "./rows.ts"
export * from "./state.ts"
export * from "./ready-work.ts"
