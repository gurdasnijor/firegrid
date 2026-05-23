// Pure RuntimeContext loop-state vocabulary.
//
// Logical pipeline position: events/ (the first layer of the pipeline). Pure:
// no Effect, no Layer, no Context.Tag, no DurableTable, no I/O. The schemas
// here describe the durable state row, NOT how it is stored — the storage
// authority (`RuntimeContextStateTable`, `RuntimeContextStateStore`,
// `makePerContextRuntimeContextStateStore`) lives one stage later under
// `tables/runtime-context-state.ts` and imports these schemas. The pipeline
// rule from
// `docs/architecture/2026-05-22-runtime-physical-target-tree.md`
// is `events < tables`, so the dependency direction is strictly tables → events.
//
// `RuntimeExitEvidence` lives here because the durable state row stores it
// (see `RuntimeContextEventStateSchema.exitEvidence` below). It used to live
// in `workflow-engine/workflows/runtime-context-run.ts`; the legacy module
// now re-exports it from here transitively through `tables/`.

import { Schema } from "effect"
import { RuntimeIngressInputRowSchema } from "@firegrid/protocol/runtime-ingress"
import { AgentInputEventSchema } from "./agent-input.ts"

export const RuntimeExitEvidence = Schema.Struct({
  exitCode: Schema.Number,
  signal: Schema.optional(Schema.String),
})
export type RuntimeExitEvidence = Schema.Schema.Type<typeof RuntimeExitEvidence>

// Internal: composed into `RuntimeContextEventStateSchema` below; downstream
// consumers (the durable-table row schema in `tables/runtime-context-state.ts`
// and the transform action schema) compose the parent state schema, not this
// element schema, so this stays unexported.
const PendingPermissionResponseSchema = Schema.Struct({
  permissionRequestId: Schema.String,
  row: RuntimeIngressInputRowSchema,
  event: AgentInputEventSchema,
})
export type PendingPermissionResponse = Schema.Schema.Type<typeof PendingPermissionResponseSchema>

export const RuntimeContextEventStateSchema = Schema.Struct({
  lastProcessedInputSequence: Schema.Number,
  lastProcessedOutputSequence: Schema.Number,
  pendingPermissionRequests: Schema.Array(Schema.String),
  pendingPermissionResponses: Schema.Array(PendingPermissionResponseSchema),
  exitEvidence: Schema.optional(RuntimeExitEvidence),
})
export type RuntimeContextEventState = Schema.Schema.Type<typeof RuntimeContextEventStateSchema>

export const initialRuntimeContextEventState: RuntimeContextEventState = {
  lastProcessedInputSequence: -1,
  lastProcessedOutputSequence: -1,
  pendingPermissionRequests: [],
  pendingPermissionResponses: [],
}
