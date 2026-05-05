import {
  type StateSchema,
  type StreamDB,
  type StreamStateDefinition,
} from "@durable-streams/state"
import { Data } from "effect"
import type { Duration, Effect, Scope, Stream } from "effect"
import { buildProjectionCore } from "../projection-service.ts"
import { acquireStreamDb } from "../stream.ts"

// client-event-plane-registration.PROJECTION_API.1, .2, .3, .4
// Per-plane Projection service. Mirrors the substrate Projection facade
// shape (snapshot / stream / until) but is bound to ONE plane's
// StateSchema and stream URL. Substrate's `Projection` Context.Tag is
// untouched (PROJECTION_API.2 — no raw StreamDB / DSS envelope leak).

export class PlaneProjectionReadError extends Data.TaggedError(
  "substrate/PlaneProjectionReadError",
)<{
  readonly planeName: string
  readonly cause: unknown
}> {}

export class PlaneProjectionWaitTimeout extends Data.TaggedError(
  "substrate/PlaneProjectionWaitTimeout",
)<{
  readonly planeName: string
  readonly label: string
  readonly elapsed: Duration.Duration
}> {}

// PROJECTION_API.3 — every query carries its row-authority kind so
// downstream code (and humans reading the call site) cannot mistake an
// observational row for an ownership-authoritative one.
export type RowAuthority =
  | "observational"
  | "eligibility-producing"
  | "terminal-domain"

// Snapshot shape derived from a StateSchema: one ReadonlyMap per
// collection (key -> row value). Substrate-internal — not part of the
// substrate public API; only Plane consumers see it.
export type PlaneSnapshot<S extends StreamStateDefinition> = {
  readonly [K in keyof S]: ReadonlyMap<
    string,
    S[K] extends { schema: { "~standard": { types?: { output: infer T } } } }
      ? T
      : unknown
  >
}

export interface PlaneProjectionQuery<S extends StreamStateDefinition, A, E = never, R = never> {
  readonly label: string
  readonly authority: RowAuthority
  readonly evaluate: (snap: PlaneSnapshot<S>) => Effect.Effect<A, E, R>
}

export interface PlaneProjection<S extends StreamStateDefinition> {
  readonly snapshot: <A, E, R>(
    query: PlaneProjectionQuery<S, A, E, R>,
  ) => Effect.Effect<A, PlaneProjectionReadError | E, R>

  readonly stream: <A, E, R>(
    query: PlaneProjectionQuery<S, A, E, R>,
  ) => Stream.Stream<A, PlaneProjectionReadError | E, R>

  readonly until: <A, E, R>(
    query: PlaneProjectionQuery<S, A, E, R>,
    predicate: (value: A) => boolean,
    options?: { readonly timeout?: Duration.DurationInput },
  ) => Effect.Effect<A, PlaneProjectionWaitTimeout | PlaneProjectionReadError | E, R>
}

interface MakePlaneProjectionArgs<S extends StreamStateDefinition> {
  readonly planeName: string
  readonly streamUrl: string
  readonly contentType?: string
  readonly state: StateSchema<S>
}

// Type alias: createStreamDB infers TDef from the runtime value of `state`.
// When we pass `StateSchema<S>` (whose K-th key value extends CollectionDefinition),
// inference picks `StateSchema<S>` as TDef. So the DB type is
// StreamDB<StateSchema<S>>, NOT StreamDB<S>. We expose this alias once so
// callers don't have to repeat the wrapping.
type PlaneStreamDB<S extends StreamStateDefinition> = StreamDB<StateSchema<S>>

const acquireDb = <S extends StreamStateDefinition>(
  args: MakePlaneProjectionArgs<S>,
): Effect.Effect<PlaneStreamDB<S>, PlaneProjectionReadError, Scope.Scope> =>
  acquireStreamDb(
    {
      url: args.streamUrl,
      ...(args.contentType !== undefined ? { contentType: args.contentType } : {}),
      state: args.state,
    },
    (cause) =>
      new PlaneProjectionReadError({ planeName: args.planeName, cause }),
  )

const snapshotFromDb = <S extends StreamStateDefinition>(
  db: PlaneStreamDB<S>,
): PlaneSnapshot<S> => {
  const out: Record<string, ReadonlyMap<string, unknown>> = {}
  for (const key of Object.keys(db.collections) as Array<keyof typeof db.collections>) {
    out[key as string] = new Map(
      (db.collections[key] as { state: Iterable<[string, unknown]> }).state,
    )
  }
  return out as PlaneSnapshot<S>
}

// Returns a long-lived `PlaneProjection` over the provided StreamDB.
// Caller wraps this in Layer.scoped so the StreamDB is closed on layer
// finalization.
export const buildPlaneProjectionFromDb = <S extends StreamStateDefinition>(
  args: MakePlaneProjectionArgs<S>,
  db: PlaneStreamDB<S>,
): PlaneProjection<S> => {
  const collectionList = Object.values(db.collections) as Array<{
    subscribeChanges: (
      cb: () => void,
      opts?: { includeInitialState?: boolean },
    ) => { unsubscribe: () => void }
  }>

  const core = buildProjectionCore<
    PlaneStreamDB<S>,
    PlaneSnapshot<S>,
    PlaneProjectionReadError,
    PlaneProjectionWaitTimeout
  >({
    db,
    snapshotFromDb,
    subscribe: (_db, evaluateAndEmit) =>
      collectionList.map((c, i) =>
        c.subscribeChanges(
          evaluateAndEmit,
          i === 0 ? { includeInitialState: true } : undefined,
        ),
      ),
    timeout: (label, elapsed) =>
      new PlaneProjectionWaitTimeout({
        planeName: args.planeName,
        label,
        elapsed,
      }),
  })
  return core
}

// acquireDb is internal; layer.ts composes it with buildPlaneProjectionFromDb.
export { acquireDb as acquirePlaneDb }
