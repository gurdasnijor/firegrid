/* eslint-disable @effect/no-import-from-barrel-package -- firegrid-agent-runtime-substrate.TOPOLOGY_PROFILE.2 */
import {
  FiregridClient,
  FiregridClientLive,
  type FiregridClientConfig,
} from "@firegrid/client"
import { Firegrid } from "@firegrid/runtime"
/* eslint-enable @effect/no-import-from-barrel-package */
import { Effect } from "effect"
import {
  SessionEvents,
  SessionTurn,
  type SessionEvent,
  type SessionTurnInput,
} from "../shared/protocol.ts"

const nowIso = (): string => new Date().toISOString()

const wordCount = (message: string): number =>
  message.trim().length === 0
    ? 0
    : message.trim().split(/\s+/).length

const deterministicReply = (input: SessionTurnInput): string => {
  const compact = input.message.trim().replace(/\s+/g, " ")
  const reversed = compact.split(/\s+/).reverse().join(" ")
  return `Local deterministic turn ${input.ordinal}: ${reversed} (${wordCount(input.message)} words).`
}

const eventId = (
  input: SessionTurnInput,
  sequence: number,
  type: SessionEvent["type"],
): string => `${input.turnId}:${sequence}:${type}`

const timelineFor = (
  input: SessionTurnInput,
  at: string,
): readonly SessionEvent[] => {
  const base = {
    sessionId: input.sessionId,
    turnId: input.turnId,
    at,
  }
  return [
    {
      ...base,
      eventId: eventId(input, 1, "user_message"),
      sequence: input.ordinal * 10 + 1,
      type: "user_message",
      text: input.message,
    },
    {
      ...base,
      eventId: eventId(input, 2, "turn_started"),
      sequence: input.ordinal * 10 + 2,
      type: "turn_started",
      provider: "local-deterministic",
      model: "echo-rewrite-count",
    },
    {
      ...base,
      eventId: eventId(input, 3, "assistant_message"),
      sequence: input.ordinal * 10 + 3,
      type: "assistant_message",
      text: deterministicReply(input),
      wordCount: wordCount(input.message),
    },
    {
      ...base,
      eventId: eventId(input, 4, "turn_complete"),
      sequence: input.ordinal * 10 + 4,
      type: "turn_complete",
      summary: `Completed local deterministic turn ${input.ordinal}.`,
    },
  ]
}

const emitTimeline = (
  cfg: FiregridClientConfig,
  input: SessionTurnInput,
): Effect.Effect<void, unknown> => {
  const clientLayer = FiregridClientLive(cfg)
  return Effect.gen(function* () {
    const client = yield* FiregridClient
    yield* Effect.forEach(
      timelineFor(input, nowIso()),
      (event) => client.emit(SessionEvents, event),
      { discard: true },
    )
  }).pipe(Effect.provide(clientLayer))
}

// flamecast-product-contract.LOWERING.7
// firegrid-agent-runtime-substrate.TOPOLOGY_PROFILE.2
// firegrid-platform-invariants.AUTHORITY.1
export const makeFlamecastRuntime = (cfg: FiregridClientConfig) =>
  Firegrid.composeRuntime({
    handlers: [
      Firegrid.handler(SessionTurn, (input) =>
        emitTimeline(cfg, input).pipe(
          Effect.as({
            sessionId: input.sessionId,
            turnId: input.turnId,
            summary: `Completed local deterministic turn ${input.ordinal}.`,
          }),
        ),
      ),
    ],
  })
