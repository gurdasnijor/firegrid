import {
  createDurableStateDb,
  sessionStateSchema,
} from "@firegrid/durable-streams"
import type {
  MessageProjection,
  SessionProjection,
} from "@firegrid/protocol/session"
import { Effect, Layer, Stream } from "effect"
import {
  EventPipeline,
  EventPipelineLive,
  EventProjector,
  EventSource,
  type EventProjectorService,
  type EventSourceService,
} from "../event-pipeline.ts"
import {
  MaterializationStrategy,
  projectionError,
  type MaterializationStrategyService,
} from "../core/index.ts"
import type { ProjectionQuery } from "../core/index.ts"
import type { SessionProjectionQuery } from "../session-projection-definition.ts"
import {
  StateProtocolEventSinkLive,
  StateProtocolWriterLive,
} from "../sinks/state-protocol/index.ts"

export interface StateProtocolStrategyOptions {
  readonly streamUrl: string
  readonly contextId: string
}

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
      Layer.provide(StateProtocolEventSinkLive({
        streamUrl: options.streamUrl,
        contextId: options.contextId,
      })),
      Layer.provide(StateProtocolWriterLive),
    )

    return Effect.scoped(
      EventPipeline.pipe(
        Effect.flatMap(pipeline => pipeline.run),
        Effect.provide(layer),
        Effect.mapError(cause => projectionError("state-protocol-strategy.run", cause)),
      ),
    )
  }

const isSessionProjectionQuery = (
  query: unknown,
): query is SessionProjectionQuery => {
  if (typeof query !== "object" || query === null || !("_tag" in query)) return false
  const tag = (query as { readonly _tag: unknown })._tag
  return tag === "sessions" || tag === "messages"
}

const querySessionRows = (
  streamUrl: string,
  query: SessionProjectionQuery,
): Effect.Effect<ReadonlyArray<unknown>, unknown> =>
  Effect.tryPromise(async () => {
    const sessionDb = createDurableStateDb({
      streamOptions: {
        url: streamUrl,
        contentType: "application/json",
      },
      state: sessionStateSchema,
    })
    await sessionDb.preload()
    try {
      switch (query._tag) {
        case "sessions":
          return Array.from(sessionDb.collections.sessions.state.values()).filter(
            (session: SessionProjection) =>
              query.contextId === undefined || session.contextId === query.contextId,
          )
        case "messages":
          return Array.from(sessionDb.collections.messages.state.values()).filter(
            (message: MessageProjection) =>
              (query.contextId === undefined || message.contextId === query.contextId) &&
              (query.sessionId === undefined || message.sessionId === query.sessionId),
          )
      }
    } finally {
      sessionDb.close()
    }
  })

const queryProjection = (
  options: StateProtocolStrategyOptions,
): MaterializationStrategyService["query"] =>
  <A, Query>(query: ProjectionQuery<A, Query>) => {
    if (query.targetName !== "session-state" || !isSessionProjectionQuery(query.query)) {
      return Effect.fail(projectionError(
        "state-protocol-strategy.query",
        new Error(`unsupported projection query target: ${query.targetName}`),
      ))
    }

    return querySessionRows(options.streamUrl, query.query).pipe(
      Effect.map(rows => query.select(rows)),
      Effect.mapError(cause => projectionError("state-protocol-strategy.query", cause)),
    )
  }

/**
 * firegrid-materialization-engines.ENGINE.5
 * firegrid-materialization-engines.ENGINE.3
 * firegrid-materialization-engines.STATE_PROTOCOL.1
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
