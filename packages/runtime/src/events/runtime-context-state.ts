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
  // Wave D-A Shape (b) — identity-keyed input dedup (CC2 directive,
  // validated by #712). `RuntimeIngressInputRow` intent-derived rows
  // carry no sequence (`tables/runtime-context-input-facts.ts:53-57`
  // explicitly drops the allocator); the Shape C subscriber handler
  // dedup uses `processedInputIds` membership instead of an ordinal
  // cursor. First input is delivered on every fresh subscriber (vs
  // the silently-dropped `(undefined ?? -1) <= -1` outcome the legacy
  // cursor produced).
  processedInputIds: Schema.Array(Schema.String),
  // PARK: `lastProcessedInputSequence` retained for the workflow body
  // at `workflow-engine/workflows/runtime-context.ts:410,501,513,541,
  // 547`. The body's per-sequence `awaitRuntimeInput` mailbox path
  // (`runtime-input-deferred.ts`) is sequence-indexed; rewriting it to
  // identity-keyed is the mailbox-retirement work in D-E. Until that
  // body retires, the schema carries both fields: handler uses
  // `processedInputIds`, body uses `lastProcessedInputSequence`. Grep
  // blocker for field removal:
  //   grep -rn "lastProcessedInputSequence" packages/runtime/src/workflow-engine/workflows/runtime-context.ts
  lastProcessedInputSequence: Schema.Number,
  lastProcessedOutputSequence: Schema.Number,
  pendingPermissionRequests: Schema.Array(Schema.String),
  pendingPermissionResponses: Schema.Array(PendingPermissionResponseSchema),
  exitEvidence: Schema.optional(RuntimeExitEvidence),
})
export type RuntimeContextEventState = Schema.Schema.Type<typeof RuntimeContextEventStateSchema>

export const initialRuntimeContextEventState: RuntimeContextEventState = {
  processedInputIds: [],
  lastProcessedInputSequence: -1,
  lastProcessedOutputSequence: -1,
  pendingPermissionRequests: [],
  pendingPermissionResponses: [],
}
