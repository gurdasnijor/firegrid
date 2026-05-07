/* eslint-disable @effect/no-import-from-barrel-package -- flamecast-product-contract.LOWERING.7 */
import { EventStream, Operation } from "@firegrid/client"
import { Schema } from "effect"
/* eslint-enable @effect/no-import-from-barrel-package */

export const SessionTurn = Operation.define({
  name: "flamecast.local.session.turn",
  input: Schema.Struct({
    sessionId: Schema.String,
    turnId: Schema.String,
    message: Schema.String,
    ordinal: Schema.Number,
  }),
  output: Schema.Struct({
    sessionId: Schema.String,
    turnId: Schema.String,
    summary: Schema.String,
  }),
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
  }),
})

export type SessionTurnInput = Operation.Input<typeof SessionTurn>

const TimelineBase = {
  eventId: Schema.String,
  sessionId: Schema.String,
  turnId: Schema.String,
  sequence: Schema.Number,
  at: Schema.String,
} as const

export const SessionEvents = EventStream.define({
  name: "flamecast.local.session.events",
  event: Schema.Union(
    Schema.Struct({
      ...TimelineBase,
      type: Schema.Literal("user_message"),
      text: Schema.String,
    }),
    Schema.Struct({
      ...TimelineBase,
      type: Schema.Literal("turn_started"),
      provider: Schema.Literal("local-deterministic"),
      model: Schema.Literal("echo-rewrite-count"),
    }),
    Schema.Struct({
      ...TimelineBase,
      type: Schema.Literal("assistant_message"),
      text: Schema.String,
      wordCount: Schema.Number,
    }),
    Schema.Struct({
      ...TimelineBase,
      type: Schema.Literal("turn_complete"),
      summary: Schema.String,
    }),
    Schema.Struct({
      ...TimelineBase,
      type: Schema.Literal("error"),
      message: Schema.String,
    }),
  ),
})

export type SessionEvent = EventStream.Event<typeof SessionEvents>

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

const titleFrom = (event: SessionEvent): string => {
  if (event.type !== "user_message") return "Local Flamecast session"
  const compact = event.text.trim().replace(/\s+/g, " ")
  if (compact.length === 0) return "Local Flamecast session"
  return compact.length > 56 ? `${compact.slice(0, 53)}...` : compact
}

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
    const status: SessionSummary["status"] = failed
      ? "failed"
      : completeTurns > 0
        ? "complete"
        : "running"
    return {
      sessionId,
      title: first === undefined ? "Local Flamecast session" : titleFrom(first),
      status,
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
