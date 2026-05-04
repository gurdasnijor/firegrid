import { Brand } from "effect"

// choreography-facade.CURRENT_WORK_CONTEXT.2
// choreography-facade.CURRENT_WORK_CONTEXT.3
// Brands are zero-runtime-cost and prevent accidental cross-id swapping at
// the choreography boundary. They are introduced only on new
// choreography-facing surface; kernel runId/completionId/ownerId strings are
// not retrofitted.
//
// choreography-facade.CURRENT_WORK_CONTEXT.5
// In v1 a WorkId carries the same string identity as a durable.run runId.
// No separate work row is introduced.

export type WorkId = string & Brand.Brand<"WorkId">
export const WorkId = Brand.nominal<WorkId>()

export type CompletionId = string & Brand.Brand<"CompletionId">
export const CompletionId = Brand.nominal<CompletionId>()

export type OwnerId = string & Brand.Brand<"OwnerId">
export const OwnerId = Brand.nominal<OwnerId>()
