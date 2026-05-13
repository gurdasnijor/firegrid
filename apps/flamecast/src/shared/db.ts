import { Effect, Option } from "effect"
import {
  FlamecastTable,
  type FlamecastAgentsWebhook,
  type FlamecastMessage,
  type FlamecastSession,
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

type CollectionSnapshot<A> = {
  readonly state: Map<string, A>
  readonly get: (key: string) => A | undefined
  readonly subscribeChanges: (callback: () => void) => { readonly unsubscribe: () => void }
}

export interface FlamecastDb {
  readonly preload: () => Promise<void>
  readonly close: () => void
  readonly collections: {
    readonly turns: CollectionSnapshot<FlamecastTurn>
    readonly messages: CollectionSnapshot<FlamecastMessage>
    readonly agentWebhooks: CollectionSnapshot<FlamecastAgentsWebhook>
    readonly sessions: CollectionSnapshot<FlamecastSession>
  }
  readonly actions: {
    readonly submitTurn: (input: SubmitTurnInput) => { readonly isPersisted: { readonly promise: Promise<void> } }
    readonly completeTurn: (input: CompleteTurnInput) => { readonly isPersisted: { readonly promise: Promise<void> } }
    readonly acceptAgentsWebhook: (input: AcceptAgentsWebhookInput) => { readonly isPersisted: { readonly promise: Promise<void> } }
    readonly completeAgentsWebhook: (input: CompleteAgentsWebhookInput) => { readonly isPersisted: { readonly promise: Promise<void> } }
  }
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

const collectionSnapshot = <A>(
  keyOf: (row: A) => string,
): CollectionSnapshot<A> & {
  setRows: (rows: ReadonlyArray<A>) => void
  notify: () => void
} => {
  const callbacks = new Set<() => void>()
  const snapshot = {
    state: new Map<string, A>(),
    get: (key: string) => snapshot.state.get(key),
    subscribeChanges: (callback: () => void) => {
      callbacks.add(callback)
      return {
        unsubscribe: () => {
          callbacks.delete(callback)
        },
      }
    },
    setRows: (rows: ReadonlyArray<A>) => {
      snapshot.state.clear()
      for (const row of rows) {
        snapshot.state.set(keyOf(row), row)
      }
    },
    notify: () => {
      for (const callback of callbacks) callback()
    },
  }
  return snapshot
}

const action = (
  run: () => Promise<void>,
) => ({
  isPersisted: {
    promise: run(),
  },
})

const optionValue = <A>(option: Option.Option<A>): A | undefined =>
  Option.isSome(option) ? option.value : undefined

export const makeFlamecastDb = (streamUrl: string): FlamecastDb => {
  const turns = collectionSnapshot<FlamecastTurn>(row => row.turnId)
  const messages = collectionSnapshot<FlamecastMessage>(row => row.messageId)
  const agentWebhooks = collectionSnapshot<FlamecastAgentsWebhook>(row => row.webhookId)
  const sessions = collectionSnapshot<FlamecastSession>(row => row.sessionId)

  const runWithTable = <A>(
    effect: Effect.Effect<A, unknown, FlamecastTable>,
  ): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(FlamecastTable.layer({
          streamOptions: { url: streamUrl, contentType },
        })),
        Effect.scoped,
      ),
    )

  const preload = async () => {
    const program = Effect.gen(function* () {
      const table = yield* FlamecastTable
      turns.setRows(yield* table.turns.query(coll => coll.toArray))
      messages.setRows(yield* table.messages.query(coll => coll.toArray))
      agentWebhooks.setRows(yield* table.agentWebhooks.query(coll => coll.toArray))
      sessions.setRows(yield* table.sessions.query(coll => coll.toArray))
    }) as Effect.Effect<void, unknown, FlamecastTable>
    await runWithTable(program)
  }

  const refresh = async () => {
    await preload()
    turns.notify()
    messages.notify()
    agentWebhooks.notify()
    sessions.notify()
  }

  return {
    preload,
    close: () => undefined,
    collections: {
      turns,
      messages,
      agentWebhooks,
      sessions,
    },
    actions: {
      submitTurn: input => action(async () => {
        const at = nowIso()
        const program = Effect.gen(function* () {
          const table = yield* FlamecastTable
          const existing = optionValue(yield* table.sessions.get(input.sessionId))
          yield* table.turns.insert({
            ...input,
            status: "submitted",
            submittedAt: at,
            updatedAt: at,
          })
          yield* table.sessions.upsert({
            sessionId: input.sessionId,
            title: existing?.title ?? titleFrom(input.message),
            status: "running",
            turnCount: existing?.turnCount ?? 0,
            updatedAt: at,
          })
        }) as Effect.Effect<void, unknown, FlamecastTable>
        await runWithTable(program)
        await refresh()
      }),
      completeTurn: ({ turn }) => action(async () => {
        const at = nowIso()
        const program = Effect.gen(function* () {
          const table = yield* FlamecastTable
          const existing = optionValue(yield* table.sessions.get(turn.sessionId))
          for (const message of messagesForTurn(turn, at)) {
            yield* table.messages.upsert(message)
          }
          yield* table.turns.upsert({
            ...turn,
            status: "completed",
            summary: `Completed local deterministic turn ${turn.ordinal}.`,
            updatedAt: at,
          })
          yield* table.sessions.upsert({
            sessionId: turn.sessionId,
            title: existing?.title ?? titleFrom(turn.message),
            status: "complete",
            turnCount: Math.max(existing?.turnCount ?? 0, turn.ordinal),
            updatedAt: at,
          })
        }) as Effect.Effect<void, unknown, FlamecastTable>
        await runWithTable(program)
        await refresh()
      }),
      acceptAgentsWebhook: input => action(async () => {
        const at = nowIso()
        const program = Effect.gen(function* () {
          const table = yield* FlamecastTable
          const existing = optionValue(yield* table.agentWebhooks.get(input.webhookId))
          if (existing !== undefined) return
          yield* table.agentWebhooks.insert({
            ...input,
            provider: "flamecast-agents",
            status: "accepted",
            acceptedAt: at,
            updatedAt: at,
          })
        }) as Effect.Effect<void, unknown, FlamecastTable>
        await runWithTable(program)
        await refresh()
      }),
      completeAgentsWebhook: ({ webhook }) => action(async () => {
        const at = nowIso()
        const program = Effect.gen(function* () {
          const table = yield* FlamecastTable
          for (const message of messagesForWebhook(webhook, at)) {
            yield* table.messages.upsert(message)
          }
          yield* table.turns.upsert(turnForWebhook(webhook, at))
          yield* table.sessions.upsert({
            sessionId: webhook.sessionId,
            title: titleFromWebhook(webhook),
            status: "complete",
            turnCount: webhook.ordinal,
            updatedAt: at,
          })
          yield* table.agentWebhooks.upsert({
            ...webhook,
            status: "processed",
            updatedAt: at,
          })
        }) as Effect.Effect<void, unknown, FlamecastTable>
        await runWithTable(program)
        await refresh()
      }),
    },
  }
}

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
      await db.preload()
      const submitted = Array.from(db.collections.turns.state.values())
        .filter((turn) => turn.status === "submitted")
        .sort((left, right) => left.ordinal - right.ordinal)
      for (const turn of submitted) {
        await db.actions.completeTurn({ turn }).isPersisted.promise
      }
    },
    catch: (cause) => cause,
  })

export const waitForFlamecastChange = (_db: FlamecastDb): Effect.Effect<void> =>
  Effect.sleep("250 millis")
