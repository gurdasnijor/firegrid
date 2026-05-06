import {
  createStreamDB,
  type StateSchema,
  type StreamDB,
  type StreamStateDefinition,
} from "@durable-streams/state"
import { Effect, type Scope } from "effect"
import {
  snapshotFromDb,
  type ProjectionSnapshot,
  type SubstrateStreamDB,
} from "../read-models/projection.ts"
import { substrateState } from "../schema/state.ts"

export interface OpenSubstrateDbOptions {
  readonly url: string
  readonly contentType?: string
}

export interface OpenStreamDbOptions<S extends StreamStateDefinition> extends OpenSubstrateDbOptions {
  readonly state: StateSchema<S>
}

export type GenericStreamDB<S extends StreamStateDefinition> = StreamDB<StateSchema<S>>

export function openStreamDb<S extends StreamStateDefinition>(
  options: OpenStreamDbOptions<S>,
): GenericStreamDB<S> {
  return createStreamDB({
    streamOptions: {
      url: options.url,
      contentType: options.contentType ?? "application/json",
    },
    state: options.state,
  })
}

// durable-records-and-projections.SUBSTRATE_SCOPE.2 — Durable Streams State is the projection envelope.
// Lower-level helper for callers that need the live StreamDB handle (e.g.
// Slice 4+ live-tail watchers). Owns the lifecycle: caller must close.
export function openSubstrateDb(options: OpenSubstrateDbOptions): SubstrateStreamDB {
  return openStreamDb({ ...options, state: substrateState })
}

// firegrid-remediation-hardening.HOT_PATHS.2
export const acquireStreamDb = <S extends StreamStateDefinition, E>(
  options: OpenStreamDbOptions<S>,
  mapError: (cause: unknown) => E,
): Effect.Effect<GenericStreamDB<S>, E, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const db = openStreamDb(options)
        await db.preload()
        return db
      },
      catch: mapError,
    }),
    (db) => Effect.sync(() => db.close()),
  )

// firegrid-remediation-hardening.HOT_PATHS.2
// firegrid-runtime-process.RUNTIME_HOT_PATH.1
// Shared scoped live-db acquisition for long-running projection readers.
// The initial preload is the no-gap catch-up boundary; callers then read
// snapshots from the live handle instead of rebuilding per wake.
export const acquireSubstrateDb = <E>(
  options: OpenSubstrateDbOptions,
  mapError: (cause: unknown) => E,
): Effect.Effect<SubstrateStreamDB, E, Scope.Scope> =>
  acquireStreamDb({ ...options, state: substrateState }, mapError)

// durable-records-and-projections.REBUILD.1
// durable-records-and-projections.REBUILD.4
// firegrid-remediation-hardening.HOT_PATHS.3
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
