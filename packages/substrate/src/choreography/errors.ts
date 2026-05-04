import { Data } from "effect"
import type { CompletionId, WorkId } from "./branded.js"

// choreography-facade.ERRORS.1
// choreography-facade.ERRORS.2
// choreography-facade.ERRORS.3
// choreography-facade.ERRORS.4
// ChoreographyTimeout is the only v1 recoverable tagged choreography error.
// It carries a branded CompletionId and the absolute durable deadlineAtMs
// that was committed when the wait was created.
//
// The v1 facade does NOT raise this error itself — it is reserved for
// host-runtime resume from a timed-out or cancelled suspended wait. v1 does
// not implement general continuation replay, so the type is exposed for
// host-runtime use without a v1-internal raise path.
export class ChoreographyTimeout extends Data.TaggedError(
  "substrate/ChoreographyTimeout",
)<{
  readonly completionId: CompletionId
  readonly deadlineAtMs: number
}> {}

// choreography-facade.SUSPENSION.6
// choreography-facade.SUSPENSION.7
// Tool-binding presentation of a verified durable suspension. Profile-
// specific sentinel naming (e.g. Fireline's SuspensionSentinel) is mapped
// from this neutral shape by the adapter; substrate ships only this neutral
// value.
//
// choreography-facade.CHOREOGRAPHY_API.4 — scheduleAt does NOT block the
// current run, so it never produces a ChoreographySuspension; it is
// intentionally absent from this union.
export type ChoreographyOperation = "sleep" | "wait_for" | "awakeable"

export interface ChoreographySuspension {
  readonly suspended: true
  readonly operation: ChoreographyOperation
  readonly workId: WorkId
  readonly completionId: CompletionId
}
