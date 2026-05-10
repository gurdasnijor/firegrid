import { Effect, Layer, Ref, Stream } from "effect"
import {
  EventPipeline,
  EventPipelineLive,
  EventProjector,
  EventSink,
  EventSource,
  type EventProjectorService,
  type EventSinkService,
  type EventSourceService,
} from "../event-pipeline.ts"
import {
  MaterializationStrategy,
  projectionError,
  type MaterializationStrategyService,
  type ProjectionDefinition,
} from "../core/index.ts"

type ProjectionState = {
  readonly targetName: string
  readonly state: unknown
  readonly query: (state: unknown, query: unknown) => ReadonlyArray<unknown>
}

type RawFoldState = ReadonlyMap<string, ProjectionState>

const rawFoldKey = (
  projectionName: string,
  targetName: string,
): string =>
  `${projectionName}:${targetName}`

const projectIntoFold = <Source, Projected, Query, State>(
  projection: ProjectionDefinition<Source, Projected, Query, State>,
  state: Ref.Ref<RawFoldState>,
): EventSinkService<Projected> =>
  ({
    writeAll: events =>
      Ref.updateAndGet(state, previous => {
        const key = rawFoldKey(projection.name, projection.target.name)
        const existing = previous.get(key)?.state as State | undefined
        const folded = events.reduce(
          (acc, event) => projection.target.fold(acc, event),
          existing ?? projection.target.initialState(),
        )
        return new Map(previous).set(key, {
          targetName: projection.target.name,
          state: folded,
          query: projection.target.query as ProjectionState["query"],
        })
      }).pipe(Effect.as(events.length)),
    flush: Effect.void,
  })

const runProjection = (
  state: Ref.Ref<RawFoldState>,
): MaterializationStrategyService["run"] =>
  projection => {
    const layer = EventPipelineLive.pipe(
      Layer.provide(Layer.succeed(
        EventSource,
        EventSource.of(projection.source as EventSourceService<unknown>),
      )),
      Layer.provide(Layer.succeed(
        EventProjector,
        EventProjector.of(
          projection.projector as unknown as EventProjectorService<unknown, unknown>,
        ),
      )),
      Layer.provide(Layer.succeed(
        EventSink,
        EventSink.of(projectIntoFold(projection, state) as EventSinkService<unknown>),
      )),
    )

    return EventPipeline.pipe(
      Effect.flatMap(pipeline => pipeline.run),
      Effect.provide(layer),
      Effect.mapError(cause => projectionError("raw-fold-strategy.run", cause)),
    )
  }

export const makeRawFoldStrategy = Effect.map(
  Ref.make<RawFoldState>(new Map()),
  state =>
    ({
      name: "raw-fold",
      run: runProjection(state),
      query: query =>
        Ref.get(state).pipe(
          Effect.flatMap(projections => {
            const key = rawFoldKey(query.projectionName, query.targetName)
            const projection = projections.get(key)
            if (projection === undefined) {
              return Effect.fail(projectionError(
                "raw-fold-strategy.query",
                new Error(`projection state not found: ${key}`),
              ))
            }
            return Effect.succeed(
              projection.query(projection.state, query) as ReadonlyArray<never>,
            )
          }),
        ),
      subscribe: query =>
        Stream.fromEffect(
          Ref.get(state).pipe(
            Effect.flatMap(projections => {
              const key = rawFoldKey(query.projectionName, query.targetName)
              const projection = projections.get(key)
              if (projection === undefined) {
                return Effect.fail(projectionError(
                  "raw-fold-strategy.subscribe",
                  new Error(`projection state not found: ${key}`),
                ))
              }
              return Effect.succeed(projection.query(
                projection.state,
                query,
              ) as ReadonlyArray<never>)
            }),
          ),
        ).pipe(Stream.flatMap(Stream.fromIterable)),
    }) satisfies MaterializationStrategyService,
)

/**
 * firegrid-materialization-engines.ENGINE.5
 * firegrid-materialization-engines.RAW_FOLD.1
 * firegrid-materialization-engines.RAW_FOLD.2
 */
export const RawFoldStrategyLive = Layer.effect(
  MaterializationStrategy,
  Effect.map(makeRawFoldStrategy, strategy => MaterializationStrategy.of(strategy)),
)
