import {
  makeFlamecastDb,
  type FlamecastDb,
} from "../shared/db.ts"
import {
  detailForSession,
  makeSessionId,
  makeTurnId,
  summarizeSessions,
  type SessionDetail,
  type SessionEvent,
  type SessionSummary,
} from "../shared/protocol.ts"

export interface FlamecastClient {
  readonly sendTurn: (input: {
    readonly sessionId?: string
    readonly message: string
    readonly ordinal: number
  }) => Promise<{ readonly sessionId: string; readonly handleId: string }>
  readonly watchEvents: (
    onEvent: (event: SessionEvent) => void,
    onError: (error: unknown) => void,
  ) => () => void
}

interface FlamecastClientConfig {
  readonly streamUrl: string
}

const eventsFromDb = (db: FlamecastDb): readonly SessionEvent[] => {
  const events: SessionEvent[] = []
  for (const message of db.collections.messages.state.values()) {
    if (message.role === "user") {
      events.push({
        eventId: message.messageId,
        sessionId: message.sessionId,
        turnId: message.turnId,
        sequence: message.sequence,
        at: message.at,
        type: "user_message",
        text: message.text,
      })
    } else {
      events.push({
        eventId: message.messageId,
        sessionId: message.sessionId,
        turnId: message.turnId,
        sequence: message.sequence,
        at: message.at,
        type: "assistant_message",
        text: message.text,
        wordCount: message.wordCount ?? 0,
      })
    }
  }
  for (const turn of db.collections.turns.state.values()) {
    if (turn.status === "completed") {
      events.push({
        eventId: `${turn.turnId}:complete`,
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        sequence: turn.ordinal * 10 + 3,
        at: turn.updatedAt,
        type: "turn_complete",
        summary: turn.summary ?? `Completed turn ${turn.ordinal}.`,
      })
    }
    if (turn.status === "failed") {
      events.push({
        eventId: `${turn.turnId}:error`,
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        sequence: turn.ordinal * 10 + 3,
        at: turn.updatedAt,
        type: "error",
        message: turn.error ?? "Turn failed",
      })
    }
  }
  return events.sort((left, right) =>
    left.sequence === right.sequence
      ? left.eventId.localeCompare(right.eventId)
      : left.sequence - right.sequence,
  )
}

export const createFlamecastClient = (
  cfg: FlamecastClientConfig,
): FlamecastClient => ({
  sendTurn: async (input) => {
    const db = makeFlamecastDb(cfg.streamUrl)
    try {
      await db.preload()
      const sessionId = input.sessionId ?? makeSessionId()
      const turnId = makeTurnId()
      await db.actions.submitTurn({
        sessionId,
        turnId,
        message: input.message,
        ordinal: input.ordinal,
      }).isPersisted.promise
      return { sessionId, handleId: turnId }
    } finally {
      db.close()
    }
  },
  watchEvents: (onEvent, onError) => {
    const db = makeFlamecastDb(cfg.streamUrl)
    const seen = new Set<string>()
    let closed = false

    void db.preload().then(() => {
      const tick = () => {
        try {
          for (const event of eventsFromDb(db)) {
            if (seen.has(event.eventId)) continue
            seen.add(event.eventId)
            onEvent(event)
          }
        } catch (error) {
          onError(error)
        }
      }
      const messages = db.collections.messages.subscribeChanges(tick)
      const turns = db.collections.turns.subscribeChanges(tick)
      const close = () => {
        messages.unsubscribe()
        turns.unsubscribe()
        db.close()
      }
      if (closed) close()
      cleanup = close
    }).catch(onError)

    let cleanup = () => {
      closed = true
      db.close()
    }
    return () => cleanup()
  },
})

export const sessionsFromEvents = summarizeSessions
export const sessionDetailFromEvents = detailForSession
export type { SessionDetail, SessionEvent, SessionSummary }
