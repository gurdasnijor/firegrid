// durable-records-and-projections.SCHEMA_LAYOUT.1
// ready-work-projection.READY_WORK_PROJECTION.7
//
// Compatibility schema barrel. Durable protocol row/state schemas live under
// protocol/schema. The ready-work projection-output contract remains here until
// the projection/read-model restructuring slice gives it a dedicated home.

export * from "../protocol/schema/rows.ts"
export * from "../protocol/schema/state.ts"
export * from "./ready-work.ts"
