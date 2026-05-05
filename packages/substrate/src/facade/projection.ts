import { Context, Data, Effect, Layer } from "effect"
import type { Duration, Stream } from "effect"
import {
  snapshotFromDb,
  type ProjectionSnapshot,
  type SubstrateStreamDB,
} from "../projection.ts"
import { buildProjectionCore } from "../projection-service.ts"
import { acquireSubstrateDb } from "../stream.ts"

// ergonomic-facade.PROJECTION_API.1, .2, .3, .4, .5, .6
// Effect-native projection facade. Snapshot + Stream + Until over a
// scoped, long-lived StreamDB acquired by ProjectionLive. Live-follow
// uses @tanstack/db `subscribeChanges({ includeInitialState: true })`
// for a no-gap snapshot+follow boundary; this facade does NOT poll.

// ergonomic-facade.PROJECTION_API.6
// effect-native-api.SCHEMA_FIRST.4 — query carries an Effect evaluator so
// decode/derive dependencies stay in R.
export interface ProjectionQuery<A, E = never, R = never> {
  readonly label: string
  readonly evaluate: (snapshot: ProjectionSnapshot) => Effect.Effect<A, E, R>
}

export class ProjectionReadError extends Data.TaggedError(
  "substrate/ProjectionReadError",
)<{
  readonly cause: unknown
}> {}

export class ProjectionWaitTimeout extends Data.TaggedError(
  "substrate/ProjectionWaitTimeout",
)<{
  readonly label: string
  readonly elapsed: Duration.Duration
}> {}

export interface ProjectionService {
  // ergonomic-facade.PROJECTION_API.2
  readonly snapshot: <A, E, R>(
    query: ProjectionQuery<A, E, R>,
  ) => Effect.Effect<A, ProjectionReadError | E, R>

  // ergonomic-facade.PROJECTION_API.3
  readonly stream: <A, E, R>(
    query: ProjectionQuery<A, E, R>,
  ) => Stream.Stream<A, ProjectionReadError | E, R>

  // ergonomic-facade.PROJECTION_API.4, .5
  readonly until: <A, E, R>(
    query: ProjectionQuery<A, E, R>,
    predicate: (value: A) => boolean,
    options?: {
      readonly timeout?: Duration.DurationInput
    },
  ) => Effect.Effect<A, ProjectionWaitTimeout | ProjectionReadError | E, R>
}

export class Projection extends Context.Tag("substrate/Projection")<
  Projection,
  ProjectionService
>() {}

export interface ProjectionLiveConfig {
  readonly streamUrl: string
  readonly contentType?: string
}

const acquireDb = (cfg: ProjectionLiveConfig) =>
  acquireSubstrateDb(
    {
      url: cfg.streamUrl,
      ...(cfg.contentType !== undefined ? { contentType: cfg.contentType } : {}),
    },
    (cause) => new ProjectionReadError({ cause }),
  )

const buildService = (db: SubstrateStreamDB): ProjectionService => {
  const core = buildProjectionCore<
    SubstrateStreamDB,
    ProjectionSnapshot,
    ProjectionReadError,
    ProjectionWaitTimeout
  >({
    db,
    snapshotFromDb,
    subscribe: (liveDb, evaluateAndEmit) => [
      liveDb.collections.runs.subscribeChanges(evaluateAndEmit, {
        includeInitialState: true,
      }),
      liveDb.collections.completions.subscribeChanges(evaluateAndEmit),
      liveDb.collections.claimAttempts.subscribeChanges(evaluateAndEmit),
    ],
    timeout: (label, elapsed) =>
      new ProjectionWaitTimeout({ label, elapsed }),
  })
  return core
}

// ergonomic-facade.PROJECTION_API.1
// effect-native-api.EFFECT_SERVICES.3 — config baked into the live layer.
// effect-native-api.EFFECT_SERVICES.9 — long-running observation is exposed
// through a scoped Layer; the underlying StreamDB is held for the layer's
// lifetime and closed on layer finalization.
export const ProjectionLive = (
  cfg: ProjectionLiveConfig,
): Layer.Layer<Projection, ProjectionReadError> =>
  Layer.scoped(
    Projection,
    Effect.map(acquireDb(cfg), (db) => buildService(db)),
  )
