interface TimelineBase {
  readonly eventId: string
  readonly sessionId: string
  readonly turnId: string
  readonly sequence: number
  readonly at: string
}

export type SessionEvent =
  | (TimelineBase & {
    readonly type: "user_message"
    readonly text: string
  })
  | (TimelineBase & {
    readonly type: "assistant_message"
    readonly text: string
    readonly wordCount: number
  })
  | (TimelineBase & {
    readonly type: "turn_complete"
    readonly summary: string
  })
  | (TimelineBase & {
    readonly type: "error"
    readonly message: string
  })

export interface SessionSummary {
  readonly sessionId: string
  readonly title: string
  readonly status: "running" | "complete" | "failed"
  readonly turnCount: number
  readonly updatedAt: string
}

export interface SessionDetail {
  readonly summary: SessionSummary
  readonly events: readonly SessionEvent[]
}

const byTimelineOrder = (left: SessionEvent, right: SessionEvent): number =>
  left.sequence === right.sequence
    ? left.eventId.localeCompare(right.eventId)
    : left.sequence - right.sequence

const titleFrom = (event: SessionEvent): string =>
  event.type === "user_message" && event.text.trim().length > 0
    ? event.text.trim().replace(/\s+/g, " ").slice(0, 56)
    : "Local Flamecast session"

export const summarizeSessions = (
  events: readonly SessionEvent[],
): readonly SessionSummary[] => {
  const bySession = events.reduce((grouped, event) => {
    grouped.set(event.sessionId, [
      ...(grouped.get(event.sessionId) ?? []),
      event,
    ])
    return grouped
  }, new Map<string, SessionEvent[]>())
  return Array.from(bySession, ([sessionId, sessionEvents]): SessionSummary => {
    const ordered = [...sessionEvents].sort(byTimelineOrder)
    const first = ordered[0]
    const last = ordered[ordered.length - 1]
    const completeTurns = ordered.filter(
      (event) => event.type === "turn_complete",
    ).length
    const failed = ordered.some((event) => event.type === "error")
    return {
      sessionId,
      title: first === undefined ? "Local Flamecast session" : titleFrom(first),
      status: failed ? "failed" : completeTurns > 0 ? "complete" : "running",
      turnCount: completeTurns,
      updatedAt: last?.at ?? new Date(0).toISOString(),
    }
  }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

export const detailForSession = (
  events: readonly SessionEvent[],
  sessionId: string,
): SessionDetail | undefined => {
  const sessionEvents = events
    .filter((event) => event.sessionId === sessionId)
    .sort(byTimelineOrder)
  const summary = summarizeSessions(sessionEvents)[0]
  if (summary === undefined) return undefined
  return { summary, events: sessionEvents }
}

export const makeSessionId = (): string => `fc_session_${crypto.randomUUID()}`
export const makeTurnId = (): string => `fc_turn_${crypto.randomUUID()}`
