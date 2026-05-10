import {
  createDurableStateDb,
} from "@firegrid/durable-streams"
import type { Scope } from "effect"
import { Effect, Layer, Stream } from "effect"
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
} from "../core/index.ts"
import type {
  ProjectionDefinition,
  ProjectionQuery,
  ProjectionTarget,
  StateProtocolTarget,
} from "../core/index.ts"
import {
  StateProtocolWriterLive,
  StateProtocolWriter,
  writerIdFor,
  type StateProtocolWriterError,
  type StateProtocolWriterHandle,
  type StateProtocolWriterOpenOptions,
} from "../sinks/state-protocol/index.ts"

export interface StateProtocolStrategyOptions {
  readonly streamUrl: string
  readonly contextId: string
}

type DurableStateDbOptions = Parameters<typeof createDurableStateDb>[0]
type StateProtocolWriterService = {
  readonly open: (
    options: StateProtocolWriterOpenOptions,
  ) => Effect.Effect<StateProtocolWriterHandle, StateProtocolWriterError, Scope.Scope>
}

const sinkError = (
  op: string,
  cause: unknown,
): EventSinkError =>
  new EventSinkError({ op, cause })

const requireStateProtocolTarget = <Projected, Query, State>(
  target: ProjectionTarget<Projected, Query, State>,
): Effect.Effect<StateProtocolTarget<Query>, EventSinkError> =>
  target.stateProtocol === undefined
    ? Effect.fail(sinkError(
      "state-protocol-strategy.target",
      new Error(`target does not expose State Protocol capability: ${target.name}`),
    ))
    : Effect.succeed(target.stateProtocol)

const stateProtocolSinkFor = <Source, Projected, Query, State>(
  options: StateProtocolStrategyOptions,
  projection: ProjectionDefinition<Source, Projected, Query, State>,
  writer: StateProtocolWriterService,
): EventSinkService<Projected> =>
  ({
    writeAll: (events, context) =>
      Effect.scoped(Effect.gen(function* () {
        const stateProtocol = yield* requireStateProtocolTarget(projection.target)
        const handle = yield* writer.open({
          streamUrl: options.streamUrl,
          writerId: writerIdFor(context.projector, options.contextId),
        }).pipe(
          Effect.mapError(cause => sinkError("state-protocol-strategy.open", cause)),
        )
        yield* Effect.forEach(events, event =>
          handle.append(stateProtocol.encode(event, {
            projection: {
              name: projection.name,
              version: projection.version,
            },
            projector: context.projector,
          })).pipe(
            Effect.mapError(cause =>
              sinkError("state-protocol-strategy.append", cause)),
          ), { discard: true })
        yield* handle.flush.pipe(
          Effect.mapError(cause => sinkError("state-protocol-strategy.flush", cause)),
        )
        return events.length
      })),
    flush: Effect.void,
  })

const runProjection = (
  options: StateProtocolStrategyOptions,
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
      Layer.provide(Layer.effect(
        EventSink,
        Effect.map(StateProtocolWriter, writer =>
          EventSink.of(
            stateProtocolSinkFor(
              options,
              projection,
              writer,
            ) as EventSinkService<unknown>,
          )),
      )),
      Layer.provide(StateProtocolWriterLive),
    )

    return requireStateProtocolTarget(projection.target).pipe(
      Effect.mapError(cause =>
        projectionError("state-protocol-strategy.target", cause)),
      Effect.zipRight(Effect.scoped(
        EventPipeline.pipe(
          Effect.flatMap(pipeline => pipeline.run),
          Effect.provide(layer),
          Effect.mapError(cause =>
            projectionError("state-protocol-strategy.run", cause)),
        ),
      )),
    )
  }

const queryStateProtocolTarget = <A>(
  streamUrl: string,
  stateProtocol: StateProtocolTarget<unknown>,
  query: ProjectionQuery<A, unknown>,
): Effect.Effect<ReadonlyArray<A>, unknown> =>
  Effect.tryPromise(async () => {
    const store = createDurableStateDb({
      streamOptions: {
        url: streamUrl,
        contentType: "application/json",
      },
      state: stateProtocol.stateSchema as DurableStateDbOptions["state"],
    })
    await store.preload()
    try {
      return stateProtocol.query(store, query)
    } finally {
      store.close()
    }
  })

const queryProjection = (
  options: StateProtocolStrategyOptions,
): MaterializationStrategyService["query"] =>
  <A, Query>(query: ProjectionQuery<A, Query>) => {
    const stateProtocol = query.target.stateProtocol
    if (stateProtocol === undefined) {
      return Effect.fail(projectionError(
        "state-protocol-strategy.query",
        new Error(
          `projection target does not expose State Protocol capability: ${query.target.name}`,
        ),
      ))
    }

    return queryStateProtocolTarget(
      options.streamUrl,
      stateProtocol as StateProtocolTarget<unknown>,
      query as ProjectionQuery<A, unknown>,
    ).pipe(
      Effect.mapError(cause => projectionError("state-protocol-strategy.query", cause)),
    )
  }

/**
 * firegrid-materialization-engines.ENGINE.5
 * firegrid-materialization-engines.ENGINE.3
 * firegrid-materialization-engines.ENGINE.7
 * firegrid-materialization-engines.STATE_PROTOCOL.1
 * firegrid-materialization-engines.STATE_PROTOCOL.2
 */
export const makeStateProtocolStrategy = (
  options: StateProtocolStrategyOptions,
): MaterializationStrategyService => {
  const query = queryProjection(options)
  return {
    name: "state-protocol",
    run: runProjection(options),
    query,
    subscribe: projectionQuery =>
      Stream.fromEffect(query(projectionQuery)).pipe(
        Stream.flatMap(Stream.fromIterable),
      ),
  }
}

export const StateProtocolStrategyLive = (
  options: StateProtocolStrategyOptions,
) =>
  Layer.succeed(
    MaterializationStrategy,
    MaterializationStrategy.of(makeStateProtocolStrategy(options)),
  )
