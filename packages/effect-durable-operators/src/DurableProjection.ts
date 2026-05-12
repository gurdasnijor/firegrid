/**
 * DurableProjection — bridge between raw fact streams and State Protocol
 * change events consumed by `DurableTable`.
 *
 * Implements:
 *  - effect-durable-operators.PROJECTION.1 — raw facts → State Protocol
 *    change-event stream
 *  - effect-durable-operators.PROJECTION.2 — v0 emits change events directly,
 *    no separate reducer execution model
 *  - effect-durable-operators.PROJECTION.3 — state is allocated inside
 *    Effect (Ref / SynchronizedRef), deterministic over retained source
 *  - effect-durable-operators.PROJECTION.4 — derived outputs are exposed as
 *    Effect Stream so fan-out composes with backpressure.
 */

import type { HttpClient } from "@effect/platform"
import {
  Effect,
  Stream,
} from "effect"
import type { DurableStream } from "effect-durable-streams"
import { DurableProjectionError } from "./Errors.ts"

export interface ProjectionDefinition<State, Source, Target> {
  readonly name: string
  /** State is allocated inside Effect (Ref/SynchronizedRef), per PROJECTION.3. */
  readonly initialState: Effect.Effect<State>
  /**
   * Project a single source fact through the current state, emitting zero or
   * more target events. Implementations typically `Stream.fromEffect` an
   * atomic state-update + event computation via `Ref.modify`.
   */
  readonly project: (
    state: State,
    source: Source,
  ) => Stream.Stream<Target, DurableProjectionError>
}

export const define = <State, Source, Target>(
  def: ProjectionDefinition<State, Source, Target>,
): ProjectionDefinition<State, Source, Target> => def

export interface RunOptions<Source, SourceI, Target, TargetI> {
  /** Typed durable fact source. */
  readonly source: DurableStream.Bound<Source, SourceI>
  /**
   * Target durable stream — typed at the State Protocol change-event level.
   * The projection's emitted events are appended here so a `DurableTable`
   * materializing the same stream observes them.
   */
  readonly target: DurableStream.Bound<Target, TargetI>
  // The State type is opaque to the runner; only the projection itself
  // reads it, so `any` here is the type-level wildcard.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly definition: ProjectionDefinition<any, Source, Target>
  /**
   * If `true`, the source is read with `live: true` so the projection
   * keeps following new facts after catching up. Default `true`.
   */
  readonly live?: boolean
}

/**
 * Run a projection. Reads the source stream, projects each fact through the
 * definition's `project` function (which owns its own Effect-allocated state),
 * and appends the emitted events to `target`.
 *
 * Returns an Effect that completes when the source stream ends (only if
 * `live: false`); for live mode it runs until interrupted.
 */
export const run = <Source, SourceI, Target, TargetI>(
  opts: RunOptions<Source, SourceI, Target, TargetI>,
): Effect.Effect<void, DurableProjectionError | DurableStream.ReadError | DurableStream.WriteError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    // The projection's State type is opaque to the runner — it flows from
    // `initialState` into `project` unchanged. We carry it as `unknown`.
    const state: unknown = yield* opts.definition.initialState.pipe(
      Effect.mapError((cause) =>
        new DurableProjectionError({ projection: opts.definition.name, cause }),
      ),
    )
    const live = opts.live ?? true
    yield* opts.source
      .read({ live })
      .pipe(
        Stream.flatMap((source) => opts.definition.project(state, source)),
        Stream.mapEffect((event) => opts.target.append(event)),
        Stream.runDrain,
      )
  })
