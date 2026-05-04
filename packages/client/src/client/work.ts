import { Duration, Effect, Stream } from "effect"
import {
  Projection,
  ProjectionReadError,
  ProjectionWaitTimeout,
  WorkProducer,
  rebuildProjection,
  type ProjectionQuery,
  type RunValue,
} from "@durable-agent-substrate/substrate"

// launchable-substrate-host.CLIENT_SURFACE.1
// launchable-substrate-host.CLIENT_SURFACE.3
// launchable-substrate-host.CLIENT_SURFACE.6
// launchable-substrate-host.CLIENT_SURFACE.9
// launchable-substrate-host.CLIENT_SURFACE.10
// launchable-substrate-host.CLIENT_SURFACE.11
// launchable-substrate-host.CLIENT_SURFACE.12
//
// Curated client surface for substrate work intents and projections.
// Writes go through the existing `WorkProducer` semantics; reads compose
// the existing `Projection` facade to scope a query per workId. The
// client never exposes raw stream append, raw StreamDB collections, raw
// row builders, or DSS envelopes (CLIENT_SURFACE.7).

// launchable-substrate-host.CLIENT_SURFACE.6
// `WorkObservation` is the curated read shape returned by
// `client.work.observe(workId)` handles. It is a type alias over
// `RunValue` (or undefined when no run row exists yet for the id) — the
// substrate's authoritative run shape, surfaced through the client root
// for ergonomic consumption without re-exporting kernel modules.
export type WorkObservation = RunValue | undefined

// launchable-substrate-host.CLIENT_SURFACE.9
// Snapshot / stream / until are explicit operations: snapshot is a
// one-shot read; stream is a live subscription; until composes the
// stream with a predicate.
export interface SubstrateWorkHandle {
  readonly snapshot: () => Effect.Effect<WorkObservation, ProjectionReadError>
  readonly stream: () => Stream.Stream<WorkObservation, ProjectionReadError>
  readonly until: (
    predicate: (state: WorkObservation) => boolean,
    options?: { readonly timeout?: Duration.DurationInput },
  ) => Effect.Effect<
    WorkObservation,
    ProjectionWaitTimeout | ProjectionReadError
  >
}

// launchable-substrate-host.CLIENT_SURFACE.7
// The client root hides stream URL and id threading after open.
// `runId` is kernel/substrate vocabulary; it is intentionally absent
// from this client-facing input. Callers receive the durable identity
// back as `workId` from declareWork's result.
export interface DeclareWorkInput {
  readonly input?: unknown
  readonly idempotencyKey?: string
}

export interface DeclareWorkResult {
  readonly workId: string
}

export interface SubstrateClientWork {
  readonly declare: (
    input?: DeclareWorkInput,
  ) => Effect.Effect<DeclareWorkResult>
  readonly observe: (workId: string) => SubstrateWorkHandle
}

const observationQuery = (workId: string): ProjectionQuery<WorkObservation> => ({
  label: `work.observe:${workId}`,
  evaluate: (snap) => Effect.succeed(snap.runs.get(workId)),
})

// launchable-substrate-host.CLIENT_SURFACE.10
// snapshot reads the current no-gap materialized view once, NOT the
// long-lived StreamDB's eventually-consistent latest state. The client
// uses substrate.rebuildProjection (a fresh whole-stream rebuild per
// call) so a snapshot taken immediately after a declareWork append
// observes the new run row.
//
// Subscriptions (stream / until) keep using the long-lived Projection
// facade since those flows already follow no-gap snapshot-then-changes
// semantics through subscribeChanges with includeInitialState.
export interface SnapshotConfig {
  readonly streamUrl: string
  readonly contentType?: string
}

// Build the work facet of the SubstrateClient. The facet closes over a
// scoped Projection from ProjectionLive (stream/until), a snapshot
// config used for rebuild-based one-shot reads, and a captured
// `declareWork` callable from WorkProducer.
export type DeclareWorkFn = WorkProducer["declareWork"]

export const makeWorkFacet = (
  projection: Projection["Type"],
  declareWork: DeclareWorkFn,
  snapshotCfg: SnapshotConfig,
): SubstrateClientWork => {
  const declare: SubstrateClientWork["declare"] = (input) =>
    declareWork({
      ...(input?.input !== undefined ? { data: input.input } : {}),
      ...(input?.idempotencyKey !== undefined
        ? { idempotencyKey: input.idempotencyKey }
        : {}),
    }).pipe(
      Effect.map(({ runId }) => ({ workId: runId })),
      // launchable-substrate-host.CLIENT_SURFACE.7
      // Internal stream-write failures surface as defects; the client
      // root does not widen its public error taxonomy with raw producer
      // errors. Hosts that need to retry can wrap calls in their own
      // policy layers.
      Effect.orDie,
    )

  const snapshotEffect = (
    workId: string,
  ): Effect.Effect<WorkObservation, ProjectionReadError> =>
    Effect.tryPromise({
      try: () =>
        rebuildProjection({
          url: snapshotCfg.streamUrl,
          ...(snapshotCfg.contentType !== undefined
            ? { contentType: snapshotCfg.contentType }
            : {}),
        }),
      catch: (cause) =>
        new ProjectionReadError({ cause }) as ProjectionReadError,
    }).pipe(Effect.map((snap) => snap.runs.get(workId)))

  const observe: SubstrateClientWork["observe"] = (workId) => {
    const query = observationQuery(workId)
    return {
      snapshot: () => snapshotEffect(workId),
      stream: () => projection.stream(query),
      until: (predicate, options) =>
        options?.timeout !== undefined
          ? projection.until(query, predicate, { timeout: options.timeout })
          : projection.until(query, predicate),
    }
  }

  return { declare, observe }
}
