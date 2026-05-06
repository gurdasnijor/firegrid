import type { StreamDB } from "@durable-streams/state"
import type {
  ClaimAttemptValue,
  CompletionValue,
  RunValue,
} from "../schema/rows.ts"
import type { substrateState } from "../schema/state.ts"

// durable-records-and-projections.PROJECTIONS.6
// Materializer-fold contract; backed by Durable Streams State's StreamDB.
export const FOLD_VERSION = 1

// durable-records-and-projections.REBUILD.4
// durable-records-and-projections.SUBSTRATE_SCOPE.8
// Typed snapshot returned by rebuild. Snapshot contents are derived from
// the substrate state schema (SUBSTRATE_SCOPE.6) and decoded by the same
// Effect Schemas via the Standard Schema bridge (SCHEMA_FIRST.4).
export interface ProjectionSnapshot {
  readonly foldVersion: number
  readonly runs: ReadonlyMap<string, RunValue>
  readonly completions: ReadonlyMap<string, CompletionValue>
  // Evidence-level: each accepted attempt keyed by claimId.
  // Winner derivation is owned by claim-and-operator-authority (Slice 5/6).
  readonly claimAttempts: ReadonlyMap<string, ClaimAttemptValue>
}

export type SubstrateStreamDB = StreamDB<typeof substrateState>

export function snapshotFromDb(db: SubstrateStreamDB): ProjectionSnapshot {
  return {
    foldVersion: FOLD_VERSION,
    runs: new Map(db.collections.runs.state),
    completions: new Map(db.collections.completions.state),
    claimAttempts: new Map(db.collections.claimAttempts.state),
  }
}
