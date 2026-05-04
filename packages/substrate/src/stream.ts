import { createStreamDB } from "@durable-streams/state"
import {
  snapshotFromDb,
  type ProjectionSnapshot,
  type SubstrateStreamDB,
} from "./projection.js"
import { substrateState } from "./state-schema.js"

export interface OpenSubstrateDbOptions {
  readonly url: string
  readonly contentType?: string
}

// durable-records-and-projections.SUBSTRATE_SCOPE.2 — Durable Streams State is the projection envelope.
// Lower-level helper for callers that need the live StreamDB handle (e.g.
// Slice 4+ live-tail watchers). Owns the lifecycle: caller must close.
export function openSubstrateDb(options: OpenSubstrateDbOptions): SubstrateStreamDB {
  return createStreamDB({
    streamOptions: {
      url: options.url,
      contentType: options.contentType ?? "application/json",
    },
    state: substrateState,
  })
}

// durable-records-and-projections.REBUILD.1
// durable-records-and-projections.REBUILD.4
// Snapshot-only rebuild API: opens the StreamDB, preloads to the no-gap
// snapshot boundary, returns a typed snapshot, and closes internally.
// SUBSTRATE_SCOPE.8 — projection storage lifecycle is not part of the
// substrate-facing API for typical callers.
export async function rebuildProjection(
  options: OpenSubstrateDbOptions,
): Promise<ProjectionSnapshot> {
  const db = openSubstrateDb(options)
  try {
    await db.preload()
    return snapshotFromDb(db)
  } finally {
    db.close()
  }
}
