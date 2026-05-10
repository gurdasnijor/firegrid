import type {
  MessageProjection,
  SessionProjection,
} from "@firegrid/protocol/session"
import { Effect, Stream } from "effect"
import type {
  ProjectionQuery,
} from "../core/index.ts"
import type { SessionStateChange } from "../session-state-change.ts"
import type { SessionProjectionQuery } from "../session-projection-definition.ts"
import type {
  MaterializeProjectionCapability,
} from "./MaterializeStrategy.ts"
import {
  materializeSessionProjectionMessagesQuery,
  materializeSessionProjectionMessagesSubscribe,
  materializeSessionProjectionSessionsQuery,
  materializeSessionProjectionSessionsSubscribe,
} from "./materialize-provider.ts"

const querySessions = (
  query: ProjectionQuery<unknown, SessionProjectionQuery>,
) => {
  const sessionQuery = query.query
  return sessionQuery.contextId === undefined ? {} : { contextId: sessionQuery.contextId }
}

const queryMessages = (
  query: ProjectionQuery<unknown, SessionProjectionQuery>,
) => {
  const sessionQuery = query.query
  return {
    ...(sessionQuery.contextId === undefined ? {} : { contextId: sessionQuery.contextId }),
    ...(sessionQuery._tag === "messages" && sessionQuery.sessionId !== undefined
      ? { sessionId: sessionQuery.sessionId }
      : {}),
  }
}

/**
 * firegrid-materialization-engines.ENGINE.7
 * firegrid-materialization-engines.MATERIALIZE.2
 * firegrid-materialization-engines.MATERIALIZE.3
 */
export const materializeSessionProjectionCapability: MaterializeProjectionCapability<
  SessionStateChange,
  SessionProjectionQuery
> = {
  encode: change => change,
  query: (materialize, target, query) => {
    switch (query.query._tag) {
      case "sessions":
        return materialize.query<SessionProjection>(
          materializeSessionProjectionSessionsQuery(target, querySessions(query)),
        ).pipe(
          Effect.map(rows => query.select(rows)),
        )
      case "messages":
        return materialize.query<MessageProjection>(
          materializeSessionProjectionMessagesQuery(target, queryMessages(query)),
        ).pipe(
          Effect.map(rows => query.select(rows)),
        )
    }
  },
  subscribe: (materialize, target, query) => {
    switch (query.query._tag) {
      case "sessions":
        return materialize.subscribe(
          materializeSessionProjectionSessionsSubscribe(target, querySessions(query)),
        ).pipe(
          Stream.mapConcat(row => query.select([row])),
        )
      case "messages":
        return materialize.subscribe(
          materializeSessionProjectionMessagesSubscribe(target, queryMessages(query)),
        ).pipe(
          Stream.mapConcat(row => query.select([row])),
        )
    }
  },
}
