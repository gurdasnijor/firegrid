import type { RuntimeEvent, RuntimeOutputCursor } from "@firegrid/protocol/launch"
import type {
  MessageProjection,
  SessionProjection,
} from "@firegrid/protocol/session"
import type { ProjectionDefinition } from "./core/index.ts"
import { RuntimeOutputSessionProjector } from "./projectors/index.ts"
import { runtimeOutputEventSource } from "./runtime-output-source.ts"
import type { SessionStateChange } from "./sinks/state-protocol/index.ts"

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

/**
 * firegrid-materialization-engines.ENGINE.4
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
  target: {
    name: "session-state",
    initialState: emptySessionProjectionState,
    fold: foldSessionStateChange,
    query: (state, query) => query.select(querySessionProjectionState(state, query.query)),
  },
})
