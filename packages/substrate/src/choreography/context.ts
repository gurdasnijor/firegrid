import { Context, Layer } from "effect"
import type { OwnerId, WorkId } from "./branded.js"

// choreography-facade.CURRENT_WORK_CONTEXT.1
// choreography-facade.CURRENT_WORK_CONTEXT.2
// choreography-facade.CURRENT_WORK_CONTEXT.4
// choreography-facade.CURRENT_WORK_CONTEXT.5
// The hosting runtime supplies a CurrentWorkContext per durable invocation.
// Choreography operations read identity from this service rather than
// requiring callers to thread workId/ownerId/correlation/causation manually,
// and they never accept completion ids, claim ids, stream URLs, raw run
// rows, or Durable Streams State envelopes through the public API.
export interface CurrentWorkContextValue {
  readonly workId: WorkId
  readonly ownerId: OwnerId
  readonly correlationId?: string
  readonly causationId?: string
  readonly telemetry?: Readonly<Record<string, string>>
}

export class CurrentWorkContext extends Context.Tag(
  "substrate/CurrentWorkContext",
)<CurrentWorkContext, CurrentWorkContextValue>() {}

// Convenience layer for runtimes that already know the work identity for a
// given invocation. Long-lived hosts may instead build per-invocation layers
// directly; this helper avoids hand-rolling Layer.succeed everywhere.
export const currentWorkContextLayer = (
  value: CurrentWorkContextValue,
): Layer.Layer<CurrentWorkContext> => Layer.succeed(CurrentWorkContext, value)
