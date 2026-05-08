import { createStreamDB } from "@durable-streams/state"
import { Effect } from "effect"
import {
  flamecastState,
  type FlamecastAgentsWebhook,
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

interface AcceptAgentsWebhookInput {
  readonly webhookId: string
  readonly sessionId: string
  readonly turnId: string
  readonly ordinal: number
  readonly userMessage: string
  readonly assistantText: string
  readonly summary?: string
}

interface CompleteAgentsWebhookInput {
  readonly webhook: FlamecastAgentsWebhook
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

const webhookSummary = (webhook: FlamecastAgentsWebhook): string =>
  webhook.summary ?? `Completed Flamecast Agents webhook turn ${webhook.ordinal}.`

const titleFromWebhook = (webhook: FlamecastAgentsWebhook): string =>
  titleFrom(webhook.userMessage)

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
          await db.preload()
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
          await db.preload()
        },
      },
      acceptAgentsWebhook: {
        onMutate: (input: AcceptAgentsWebhookInput) => {
          // stream-webhook-workflows.STREAM_INGRESS.1
          // stream-webhook-workflows.STREAM_INGRESS.3
          if (db.collections.agentWebhooks.get(input.webhookId) !== undefined) return
          const at = nowIso()
          db.collections.agentWebhooks.insert({
            ...input,
            provider: "flamecast-agents",
            status: "accepted",
            acceptedAt: at,
            updatedAt: at,
          })
        },
        mutationFn: async (input: AcceptAgentsWebhookInput) => {
          const at = nowIso()
          const txid = crypto.randomUUID()
          const webhook: FlamecastAgentsWebhook = {
            ...input,
            provider: "flamecast-agents",
            status: "accepted",
            acceptedAt: at,
            updatedAt: at,
          }
          await appendJson(
            stream,
            flamecastState.agentWebhooks.upsert({
              value: webhook,
              headers: { txid },
            }),
          )
          await db.utils.awaitTxId(txid)
        },
      },
      completeAgentsWebhook: {
        onMutate: ({ webhook }: CompleteAgentsWebhookInput) => {
          // stream-webhook-workflows.WORKFLOW_PROCESSING.2
          const at = nowIso()
          for (const message of messagesForWebhook(webhook, at)) {
            if (db.collections.messages.get(message.messageId) === undefined) {
              db.collections.messages.insert(message)
            }
          }
          const turn = turnForWebhook(webhook, at)
          const existingTurn = db.collections.turns.get(turn.turnId)
          if (existingTurn === undefined) {
            db.collections.turns.insert(turn)
          } else {
            db.collections.turns.update(turn.turnId, (draft) => {
              Object.assign(draft, turn)
            })
          }
          const existingSession = db.collections.sessions.get(webhook.sessionId)
          if (existingSession === undefined) {
            db.collections.sessions.insert({
              sessionId: webhook.sessionId,
              title: titleFromWebhook(webhook),
              status: "complete",
              turnCount: webhook.ordinal,
              updatedAt: at,
            })
          } else {
            db.collections.sessions.update(webhook.sessionId, (draft) => {
              draft.status = "complete"
              draft.turnCount = Math.max(draft.turnCount, webhook.ordinal)
              draft.updatedAt = at
            })
          }
          const existingWebhook = db.collections.agentWebhooks.get(webhook.webhookId)
          if (existingWebhook !== undefined) {
            db.collections.agentWebhooks.update(webhook.webhookId, (draft) => {
              draft.status = "processed"
              draft.updatedAt = at
            })
          }
        },
        mutationFn: async ({ webhook }: CompleteAgentsWebhookInput) => {
          const at = nowIso()
          const txid = crypto.randomUUID()
          for (const message of messagesForWebhook(webhook, at)) {
            await appendJson(
              stream,
              flamecastState.messages.upsert({
                value: message,
                headers: { txid },
              }),
            )
          }
          await appendJson(
            stream,
            flamecastState.turns.upsert({
              value: turnForWebhook(webhook, at),
              headers: { txid },
            }),
          )
          await appendJson(
            stream,
            flamecastState.sessions.upsert({
              value: {
                sessionId: webhook.sessionId,
                title: titleFromWebhook(webhook),
                status: "complete",
                turnCount: webhook.ordinal,
                updatedAt: at,
              },
              headers: { txid },
            }),
          )
          await appendJson(
            stream,
            flamecastState.agentWebhooks.upsert({
              value: {
                ...webhook,
                status: "processed",
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

const turnForWebhook = (
  webhook: FlamecastAgentsWebhook,
  at: string,
): FlamecastTurn => ({
  turnId: webhook.turnId,
  sessionId: webhook.sessionId,
  ordinal: webhook.ordinal,
  message: webhook.userMessage,
  status: "completed",
  submittedAt: webhook.acceptedAt,
  updatedAt: at,
  summary: webhookSummary(webhook),
})

const messagesForWebhook = (
  webhook: FlamecastAgentsWebhook,
  at: string,
): readonly [FlamecastMessage, FlamecastMessage] => [
  {
    messageId: `${webhook.turnId}:1:user`,
    sessionId: webhook.sessionId,
    turnId: webhook.turnId,
    sequence: webhook.ordinal * 10 + 1,
    at,
    role: "user",
    text: webhook.userMessage,
  },
  {
    messageId: `${webhook.turnId}:2:assistant`,
    sessionId: webhook.sessionId,
    turnId: webhook.turnId,
    sequence: webhook.ordinal * 10 + 2,
    at,
    role: "assistant",
    text: webhook.assistantText,
    wordCount: wordCount(webhook.assistantText),
  },
]

export const pendingAgentsWebhooks = (
  db: FlamecastDb,
): readonly FlamecastAgentsWebhook[] =>
  Array.from(db.collections.agentWebhooks.state.values())
    .filter((webhook) => webhook.status === "accepted")
    .sort((left, right) => left.acceptedAt.localeCompare(right.acceptedAt))

export const processSubmittedTurns = (
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

export const waitForFlamecastChange = (db: FlamecastDb): Effect.Effect<void> =>
  Effect.async<void>((resume) => {
    const resumeOnce = () => {
      resume(Effect.void)
    }
    const turns = db.collections.turns.subscribeChanges(resumeOnce)
    const webhooks = db.collections.agentWebhooks.subscribeChanges(resumeOnce)
    return Effect.sync(() => {
      turns.unsubscribe()
      webhooks.unsubscribe()
    })
  })
