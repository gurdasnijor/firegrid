import { Effect, Layer, Stream } from "effect"
import type { Scope } from "effect"
import {
  EventPipeline,
  EventPipelineLive,
  EventProjector,
  EventSink,
  EventSinkError,
  EventSource,
  type EventProjectorService,
  type EventSinkService,
  type EventSourceService,
} from "../event-pipeline.ts"
import {
  MaterializationStrategy,
  projectionError,
  type MaterializationStrategyService,
  type ProjectionContext,
  type ProjectionDefinition,
  type ProjectionQuery,
} from "../core/index.ts"
import {
  MaterializeProvider,
  type MaterializeProviderService,
  type RuntimeOutputProjectionTarget,
} from "./materialize-types.ts"

export interface MaterializeProjectionCapability<Projected, Query = unknown> {
  readonly encode: (
    event: Projected,
    context: ProjectionContext,
  ) => unknown
  readonly query: <A>(
    materialize: MaterializeProviderService,
    target: RuntimeOutputProjectionTarget,
    query: ProjectionQuery<A, Query>,
  ) => Effect.Effect<ReadonlyArray<A>, unknown>
  readonly subscribe: <A>(
    materialize: MaterializeProviderService,
    target: RuntimeOutputProjectionTarget,
    query: ProjectionQuery<A, Query>,
  ) => Stream.Stream<A, unknown, Scope.Scope>
}

export type MaterializeCapableTarget<Projected, Query = unknown, State = unknown> =
  ProjectionDefinition<unknown, Projected, Query, State>["target"] & {
    readonly materialize?: MaterializeProjectionCapability<Projected, Query>
  }

export interface MaterializeStrategyOptions {
  readonly target: RuntimeOutputProjectionTarget
}

const sinkError = (
  op: string,
  cause: unknown,
): EventSinkError =>
  new EventSinkError({ op, cause })

const requireMaterializeTarget = <Projected, Query, State>(
  projection: ProjectionDefinition<unknown, Projected, Query, State>,
): Effect.Effect<MaterializeProjectionCapability<Projected, Query>, EventSinkError> => {
  const target = projection.target as MaterializeCapableTarget<Projected, Query, State>
  return target.materialize === undefined
    ? Effect.fail(sinkError(
      "materialize-strategy.target",
      new Error(`target does not expose Materialize capability: ${projection.target.name}`),
    ))
    : Effect.succeed(target.materialize)
}

const materializeSinkFor = <Projected, Query, State>(
  options: MaterializeStrategyOptions,
  projection: ProjectionDefinition<unknown, Projected, Query, State>,
  materialize: MaterializeProviderService,
): EventSinkService<Projected> =>
  ({
    writeAll: (events, context) =>
      requireMaterializeTarget(projection).pipe(
        Effect.flatMap(capability => {
          const projectionContext: ProjectionContext = {
            projection: {
              name: projection.name,
              version: projection.version,
            },
            projector: context.projector,
          }
          const encoded = events.map(event => capability.encode(event, projectionContext))
          return Effect.forEach(
            encoded,
            event => materialize.ingestJson(options.target, event),
            { discard: true },
          )
        }),
        Effect.mapError(cause => sinkError("materialize-strategy.ingest", cause)),
        Effect.as(events.length),
      ),
    flush: Effect.void,
  })

const pipelineLayer = <Source, Projected>(
  projection: ProjectionDefinition<Source, Projected, unknown, unknown>,
  sink: EventSinkService<Projected>,
) => {
  const sourceLayer = Layer.succeed(
    EventSource,
    EventSource.of(projection.source as EventSourceService<unknown>),
  )
  const projectorLayer = Layer.succeed(
    EventProjector,
    EventProjector.of(
      projection.projector as unknown as EventProjectorService<unknown, unknown>,
    ),
  )
  const sinkLayer = Layer.succeed(
    EventSink,
    EventSink.of(sink as EventSinkService<unknown>),
  )

  return EventPipelineLive.pipe(
    Layer.provide(sourceLayer),
    Layer.provide(projectorLayer),
    Layer.provide(sinkLayer),
  )
}

const runProjection = (
  options: MaterializeStrategyOptions,
  materialize: MaterializeProviderService,
): MaterializationStrategyService["run"] =>
  projection => {
    const projectionForMaterialize =
      projection as ProjectionDefinition<unknown, unknown, unknown, unknown>
    const layer = pipelineLayer(
      projectionForMaterialize,
      materializeSinkFor(options, projectionForMaterialize, materialize),
    )

    return requireMaterializeTarget(projectionForMaterialize).pipe(
      Effect.mapError(cause => projectionError("materialize-strategy.target", cause)),
      Effect.zipRight(EventPipeline.pipe(
        Effect.flatMap(pipeline => pipeline.run),
        Effect.provide(layer),
        Effect.mapError(cause => projectionError("materialize-strategy.run", cause)),
      )),
    )
  }

const queryProjection = (
  options: MaterializeStrategyOptions,
  materialize: MaterializeProviderService,
): MaterializationStrategyService["query"] =>
  <A, Query>(query: ProjectionQuery<A, Query>) => {
    const materializeTarget = (query.target as {
      readonly materialize?: MaterializeProjectionCapability<unknown, Query>
    }).materialize

    if (materializeTarget === undefined) {
      return Effect.fail(projectionError(
        "materialize-strategy.query",
        new Error(
          `projection target does not expose Materialize capability: ${query.target.name}`,
        ),
      ))
    }

    return materializeTarget.query(materialize, options.target, query).pipe(
      Effect.mapError(cause => projectionError("materialize-strategy.query", cause)),
    )
  }

/**
 * firegrid-materialization-engines.ENGINE.1
 * firegrid-materialization-engines.ENGINE.3
 * firegrid-materialization-engines.ENGINE.4
 * firegrid-materialization-engines.MATERIALIZE.5
 * firegrid-event-pipeline-materialization.PIPELINE.5
 */
export const makeMaterializeStrategy = (
  options: MaterializeStrategyOptions,
): Effect.Effect<MaterializationStrategyService, never, MaterializeProvider> =>
  Effect.map(MaterializeProvider, materialize => {
    const query = queryProjection(options, materialize)
    return {
      name: "materialize",
      run: runProjection(options, materialize),
      query,
      subscribe: projectionQuery => {
        const materializeTarget = (projectionQuery.target as {
          readonly materialize?: MaterializeProjectionCapability<unknown, unknown>
        }).materialize

        if (materializeTarget === undefined) {
          return Stream.fail(projectionError(
            "materialize-strategy.subscribe",
            new Error(
              `projection target does not expose Materialize capability: ${projectionQuery.target.name}`,
            ),
          ))
        }

        return materializeTarget.subscribe(
          materialize,
          options.target,
          projectionQuery,
        ).pipe(
          Stream.mapError(cause => projectionError("materialize-strategy.subscribe", cause)),
        )
      },
    } satisfies MaterializationStrategyService
  })

export const MaterializeStrategyLive = (
  options: MaterializeStrategyOptions,
) =>
  Layer.effect(
    MaterializationStrategy,
    Effect.map(makeMaterializeStrategy(options), strategy =>
      MaterializationStrategy.of(strategy)),
  )
