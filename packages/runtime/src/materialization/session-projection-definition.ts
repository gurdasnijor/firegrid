import {
  sessionStateSchema,
} from "@firegrid/durable-streams/state"
import type { RuntimeEvent, RuntimeOutputCursor } from "@firegrid/protocol/launch"
import type {
  MessageProjection,
  SessionProjection,
} from "@firegrid/protocol/session"
import type {
  ProjectionContext,
  ProjectionDefinition,
  ProjectionTarget,
  ProjectionQuery,
} from "./core/index.ts"
import type { MaterializeCapableTarget } from "./materialize/MaterializeStrategy.ts"
import { materializeSessionProjectionCapability } from "./materialize/session-projection.ts"
import { RuntimeOutputSessionProjector } from "./projectors/index.ts"
import { runtimeOutputEventSource } from "./runtime-output-source.ts"
import type { SessionStateChange } from "./session-state-change.ts"

export interface SessionProjectionDefinitionOptions {
  readonly runtimeOutputStreamUrl: string
  readonly contextId: string
  readonly since?: RuntimeOutputCursor
}

export type SessionProjectionQuery =
  | {
    readonly _tag: "sessions"
    readonly contextId?: string
  }
  | {
    readonly _tag: "messages"
    readonly contextId?: string
    readonly sessionId?: string
  }

export interface SessionProjectionState {
  readonly sessions: ReadonlyMap<string, SessionProjection>
  readonly messages: ReadonlyMap<string, MessageProjection>
}

const emptySessionProjectionState = (): SessionProjectionState => ({
  sessions: new Map(),
  messages: new Map(),
})

const foldSessionStateChange = (
  state: SessionProjectionState,
  change: SessionStateChange,
): SessionProjectionState => {
  switch (change.kind) {
    case "upsertSession": {
      const sessions = new Map(state.sessions)
      sessions.set(change.value.sessionId, change.value)
      return { ...state, sessions }
    }
    case "upsertMessage": {
      const messages = new Map(state.messages)
      messages.set(change.value.messageId, change.value)
      return { ...state, messages }
    }
  }
}

const querySessionProjectionState = (
  state: SessionProjectionState,
  query: SessionProjectionQuery,
): ReadonlyArray<unknown> => {
  switch (query._tag) {
    case "sessions":
      return Array.from(state.sessions.values()).filter(session =>
        query.contextId === undefined || session.contextId === query.contextId)
    case "messages":
      return Array.from(state.messages.values()).filter(message =>
        (query.contextId === undefined || message.contextId === query.contextId) &&
        (query.sessionId === undefined || message.sessionId === query.sessionId))
  }
}

const querySessionStateProtocolStore = <A>(
  store: unknown,
  query: ProjectionQuery<A, SessionProjectionQuery>,
): ReadonlyArray<A> => {
  const collections = (store as {
    readonly collections: {
      readonly sessions: { readonly state: ReadonlyMap<string, SessionProjection> }
      readonly messages: { readonly state: ReadonlyMap<string, MessageProjection> }
    }
  }).collections
  return query.select(querySessionProjectionState({
    sessions: collections.sessions.state,
    messages: collections.messages.state,
  }, query.query))
}

const sessionProjectionTxid = (
  context: ProjectionContext,
  kind: "message" | "session",
  id: string,
): string =>
  [context.projector.name, context.projector.version, kind, id].join(":")

const encodeSessionStateProtocolEvent = (
  change: SessionStateChange,
  context: ProjectionContext,
): unknown => {
  // firegrid-materialization-engines.ENGINE.7
  // durable-records-and-projections.PROJECTIONS.3
  switch (change.kind) {
    case "upsertSession":
      return sessionStateSchema.sessions.upsert({
        value: change.value,
        headers: {
          txid: sessionProjectionTxid(context, "session", change.value.sessionId),
        },
      })
    case "upsertMessage":
      return sessionStateSchema.messages.upsert({
        value: change.value,
        headers: {
          txid: sessionProjectionTxid(context, "message", change.value.messageId),
        },
      })
  }
}

const sessionProjectionTarget = {
  name: "session-state",
  initialState: emptySessionProjectionState,
  fold: foldSessionStateChange,
  query: (state, query) => query.select(querySessionProjectionState(state, query.query)),
  stateProtocol: {
    stateSchema: sessionStateSchema,
    encode: (change, context) =>
      encodeSessionStateProtocolEvent(change as SessionStateChange, context),
    query: querySessionStateProtocolStore,
  },
  materialize: materializeSessionProjectionCapability,
} satisfies ProjectionTarget<
  SessionStateChange,
  SessionProjectionQuery,
  SessionProjectionState
> & MaterializeCapableTarget<
  SessionStateChange,
  SessionProjectionQuery,
  SessionProjectionState
>

/**
 * firegrid-materialization-engines.ENGINE.4
 * firegrid-materialization-engines.ENGINE.7
 * firegrid-materialization-engines.STATE_PROTOCOL.2
 * firegrid-materialization-engines.MATERIALIZE.5
 */
export const createSessionProjectionDefinition = (
  options: SessionProjectionDefinitionOptions,
): ProjectionDefinition<
  RuntimeEvent,
  SessionStateChange,
  SessionProjectionQuery,
  SessionProjectionState
> => ({
  name: "runtime-output-session",
  version: "1",
  source: runtimeOutputEventSource(
    options.since === undefined
      ? {
        streamUrl: options.runtimeOutputStreamUrl,
        contextId: options.contextId,
      }
      : {
        streamUrl: options.runtimeOutputStreamUrl,
        contextId: options.contextId,
        since: options.since,
      },
  ),
  projector: RuntimeOutputSessionProjector,
  target: sessionProjectionTarget,
})
