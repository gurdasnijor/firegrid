import { createStreamDB } from "@durable-streams/state"
import { Effect } from "effect"
import {
  flamecastState,
  type FlamecastMessage,
  type FlamecastTurn,
} from "./state.ts"

const contentType = "application/json"

interface SubmitTurnInput {
  readonly sessionId: string
  readonly turnId: string
  readonly message: string
  readonly ordinal: number
}

interface CompleteTurnInput {
  readonly turn: FlamecastTurn
}

const nowIso = (): string => new Date().toISOString()

const wordCount = (message: string): number =>
  message.trim().length === 0
    ? 0
    : message.trim().split(/\s+/).length

const titleFrom = (message: string): string => {
  const compact = message.trim().replace(/\s+/g, " ")
  if (compact.length === 0) return "Local Flamecast session"
  return compact.length > 56 ? `${compact.slice(0, 53)}...` : compact
}

const deterministicReply = (turn: FlamecastTurn): string => {
  const compact = turn.message.trim().replace(/\s+/g, " ")
  const reversed = compact.split(/\s+/).reverse().join(" ")
  return `Local deterministic turn ${turn.ordinal}: ${reversed} (${wordCount(turn.message)} words).`
}

const appendJson = async (
  stream: { readonly append: (body: string) => Promise<unknown> },
  event: unknown,
) => {
  await stream.append(JSON.stringify(event))
}

export const makeFlamecastDb = (streamUrl: string) =>
  createStreamDB({
    streamOptions: { url: streamUrl, contentType },
    state: flamecastState,
    actions: ({ db, stream }) => ({
      submitTurn: {
        onMutate: (input: SubmitTurnInput) => {
          const at = nowIso()
          db.collections.turns.insert({
            ...input,
            status: "submitted",
            submittedAt: at,
            updatedAt: at,
          })
          const existing = db.collections.sessions.get(input.sessionId)
          if (existing === undefined) {
            db.collections.sessions.insert({
              sessionId: input.sessionId,
              title: titleFrom(input.message),
              status: "running",
              turnCount: 0,
              updatedAt: at,
            })
          } else {
            db.collections.sessions.update(input.sessionId, (draft) => {
              draft.status = "running"
              draft.updatedAt = at
            })
          }
        },
        mutationFn: async (input: SubmitTurnInput) => {
          const at = nowIso()
          const txid = crypto.randomUUID()
          const existing = db.collections.sessions.get(input.sessionId)
          await appendJson(
            stream,
            flamecastState.turns.insert({
              value: {
                ...input,
                status: "submitted",
                submittedAt: at,
                updatedAt: at,
              },
              headers: { txid },
            }),
          )
          await appendJson(
            stream,
            flamecastState.sessions.upsert({
              value: {
                sessionId: input.sessionId,
                title: existing?.title ?? titleFrom(input.message),
                status: "running",
                turnCount: existing?.turnCount ?? 0,
                updatedAt: at,
              },
              headers: { txid },
            }),
          )
          await db.utils.awaitTxId(txid)
        },
      },
      completeTurn: {
        onMutate: ({ turn }: CompleteTurnInput) => {
          const at = nowIso()
          db.collections.messages.insert([...messagesForTurn(turn, at)])
          db.collections.turns.update(turn.turnId, (draft) => {
            draft.status = "completed"
            draft.summary = `Completed local deterministic turn ${turn.ordinal}.`
            draft.updatedAt = at
          })
          const existing = db.collections.sessions.get(turn.sessionId)
          if (existing === undefined) {
            db.collections.sessions.insert({
              sessionId: turn.sessionId,
              title: titleFrom(turn.message),
              status: "complete",
              turnCount: turn.ordinal,
              updatedAt: at,
            })
          } else {
            db.collections.sessions.update(turn.sessionId, (draft) => {
              draft.status = "complete"
              draft.turnCount = Math.max(draft.turnCount, turn.ordinal)
              draft.updatedAt = at
            })
          }
        },
        mutationFn: async ({ turn }: CompleteTurnInput) => {
          const at = nowIso()
          const txid = crypto.randomUUID()
          const existing = db.collections.sessions.get(turn.sessionId)
          for (const message of messagesForTurn(turn, at)) {
            await appendJson(
              stream,
              flamecastState.messages.insert({
                value: message,
                headers: { txid },
              }),
            )
          }
          await appendJson(
            stream,
            flamecastState.turns.upsert({
              value: {
                ...turn,
                status: "completed",
                summary: `Completed local deterministic turn ${turn.ordinal}.`,
                updatedAt: at,
              },
              headers: { txid },
            }),
          )
          await appendJson(
            stream,
            flamecastState.sessions.upsert({
              value: {
                sessionId: turn.sessionId,
                title: existing?.title ?? titleFrom(turn.message),
                status: "complete",
                turnCount: Math.max(existing?.turnCount ?? 0, turn.ordinal),
                updatedAt: at,
              },
              headers: { txid },
            }),
          )
          await db.utils.awaitTxId(txid)
        },
      },
    }),
  })

export type FlamecastDb = ReturnType<typeof makeFlamecastDb>

const messagesForTurn = (
  turn: FlamecastTurn,
  at: string,
): readonly [FlamecastMessage, FlamecastMessage] => [
  {
    messageId: `${turn.turnId}:1:user`,
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    sequence: turn.ordinal * 10 + 1,
    at,
    role: "user",
    text: turn.message,
  },
  {
    messageId: `${turn.turnId}:2:assistant`,
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    sequence: turn.ordinal * 10 + 2,
    at,
    role: "assistant",
    text: deterministicReply(turn),
    wordCount: wordCount(turn.message),
  },
]

const processSubmittedTurns = (
  db: FlamecastDb,
): Effect.Effect<void, unknown> =>
  Effect.tryPromise({
    try: async () => {
      const submitted = Array.from(db.collections.turns.state.values())
        .filter((turn) => turn.status === "submitted")
        .sort((left, right) => left.ordinal - right.ordinal)
      for (const turn of submitted) {
        await db.actions.completeTurn({ turn }).isPersisted.promise
      }
    },
    catch: (cause) => cause,
  })

const waitForTurnChange = (db: FlamecastDb): Effect.Effect<void> =>
  Effect.async<void>((resume) => {
    const sub = db.collections.turns.subscribeChanges(() => {
      resume(Effect.void)
    })
    return Effect.sync(() => sub.unsubscribe())
  })

export const runFlamecastProcessor = (
  db: FlamecastDb,
): Effect.Effect<never, unknown> =>
  Effect.gen(function* () {
    while (true) {
      yield* processSubmittedTurns(db)
      yield* waitForTurnChange(db)
    }
  })
