import { PgClient } from "@effect/sql-pg"
import { SqlClient } from "@effect/sql"
import type { RuntimeJournalEvent } from "@firegrid/protocol/launch"
import type {
  MessageProjection,
  SessionProjection,
} from "@firegrid/protocol/session"
import { Effect, Layer, Stream } from "effect"
import {
  MaterializeProvider,
  MaterializeProviderError,
  type MaterializeQuery,
  type RuntimeOutputProjectionPlan,
  type RuntimeOutputProjectionTarget,
} from "./materialize-types.ts"

type MaterializeSql = Parameters<MaterializeQuery["statement"]>[0]

export interface MaterializeRuntimeOutputProjectionPlan
  extends RuntimeOutputProjectionPlan {
  readonly runtimeEventsViewName?: string
  readonly sessionsViewName?: string
  readonly messagesViewName?: string
}

const provider = "materialize"

const schemaNameFor = (
  plan: RuntimeOutputProjectionPlan,
): string => plan.schemaName ?? "public"

const databaseNameFor = (
  plan: RuntimeOutputProjectionPlan,
): string => plan.databaseName ?? "materialize"

const runtimeEventsViewNameFor = (
  plan: MaterializeRuntimeOutputProjectionPlan,
): string => plan.runtimeEventsViewName ?? `${plan.sourceName}_runtime_events`

const sessionsViewNameFor = (
  plan: MaterializeRuntimeOutputProjectionPlan,
): string => plan.sessionsViewName ?? `${plan.sourceName}_sessions`

const messagesViewNameFor = (
  plan: MaterializeRuntimeOutputProjectionPlan,
): string => plan.messagesViewName ?? `${plan.sourceName}_messages`

const webhookUrlFor = (
  plan: RuntimeOutputProjectionPlan,
): string | undefined =>
  plan.webhookBaseUrl === undefined
    ? undefined
    : `${plan.webhookBaseUrl.replace(/\/+$/, "")}/api/webhook/${databaseNameFor(plan)}/${schemaNameFor(plan)}/${plan.sourceName}`

const targetFor = (
  plan: MaterializeRuntimeOutputProjectionPlan,
): RuntimeOutputProjectionTarget => {
  const base = {
    provider,
    sourceName: plan.sourceName,
    databaseName: databaseNameFor(plan),
    schemaName: schemaNameFor(plan),
    runtimeEventsViewName: runtimeEventsViewNameFor(plan),
    sessionsViewName: sessionsViewNameFor(plan),
    messagesViewName: messagesViewNameFor(plan),
  }
  const webhookUrl = webhookUrlFor(plan)
  return webhookUrl === undefined ? base : { ...base, webhookUrl }
}

const mapError = (
  op: string,
  cause: unknown,
): MaterializeProviderError =>
  new MaterializeProviderError({ provider, op, cause })

const provisionSql = (
  plan: MaterializeRuntimeOutputProjectionPlan,
  sql: SqlClient.SqlClient,
) => {
  const schema = sql(schemaNameFor(plan))
  const source = sql(plan.sourceName)
  const runtimeEventsView = sql(runtimeEventsViewNameFor(plan))
  const sessionsView = sql(sessionsViewNameFor(plan))
  const messagesView = sql(messagesViewNameFor(plan))
  return [
    sql`CREATE SCHEMA IF NOT EXISTS ${schema}`,
    sql`CREATE SOURCE IF NOT EXISTS ${schema}.${source} FROM WEBHOOK BODY FORMAT JSON`,
    sql`
CREATE VIEW IF NOT EXISTS ${schema}.${runtimeEventsView} AS
SELECT
  body->>'type' AS event_type,
  body->>'id' AS journal_id,
  body->>'at' AS journal_at,
  body->'event'->>'eventId' AS event_id,
  body->'event'->>'contextId' AS context_id,
  (body->'event'->>'activityAttempt')::int AS activity_attempt,
  (body->'event'->>'sequence')::int AS sequence,
  body->'event'->>'source' AS source,
  body->'event'->>'format' AS format,
  body->'event'->>'receivedAt' AS received_at,
  body->'event'->>'raw' AS raw
FROM ${schema}.${source}
WHERE body->>'type' = 'firegrid.runtime.output.stdout'
`,
    sql`
CREATE MATERIALIZED VIEW IF NOT EXISTS ${schema}.${sessionsView} AS
SELECT
  body->'value'->>'sessionId' AS "sessionId",
  body->'value'->>'contextId' AS "contextId",
  body->'value'->>'status' AS "status"
FROM ${schema}.${source}
WHERE body->>'kind' = 'upsertSession'
`,
    sql`
CREATE MATERIALIZED VIEW IF NOT EXISTS ${schema}.${messagesView} AS
SELECT
  body->'value'->>'messageId' AS "messageId",
  body->'value'->>'sessionId' AS "sessionId",
  body->'value'->>'contextId' AS "contextId",
  body->'value'->>'role' AS "role",
  body->'value'->>'text' AS "text",
  body->'value'->>'sourceRuntimeEventId' AS "sourceRuntimeEventId",
  body->'value'->>'createdAt' AS "createdAt"
FROM ${schema}.${source}
WHERE body->>'kind' = 'upsertMessage'
`,
  ] as const
}

const runtimeEventsRelation = (
  sql: MaterializeSql,
  target: RuntimeOutputProjectionTarget,
) => ({
  schema: sql(target.schemaName),
  view: sql(target.runtimeEventsViewName),
})

const runtimeEventsContextFilter = (
  sql: MaterializeSql,
  contextId: string | undefined,
) =>
  contextId === undefined
    ? sql.literal("")
    : sql`WHERE context_id = ${contextId}`

export const materializeRuntimeEventsQuery = (
  target: RuntimeOutputProjectionTarget,
  options: {
    readonly contextId?: string
    readonly limit?: number
  } = {},
): MaterializeQuery<{
  readonly event_type: string
  readonly journal_id: string
  readonly journal_at: string
  readonly event_id: string
  readonly context_id: string
  readonly activity_attempt: number
  readonly sequence: number
  readonly source: string
  readonly format: string
  readonly received_at: string
  readonly raw: string
}> => {
  return {
    statement: sql => {
      const { schema, view } = runtimeEventsRelation(sql, target)
      const where = runtimeEventsContextFilter(sql, options.contextId)
      const limit = options.limit === undefined
        ? sql.literal("")
        : sql`LIMIT ${Math.max(0, Math.floor(options.limit))}`
      return sql`
SELECT *
FROM ${schema}.${view}
${where}
ORDER BY context_id, activity_attempt, sequence
${limit}
`
    },
  }
}

const sessionsRelation = (
  sql: MaterializeSql,
  target: RuntimeOutputProjectionTarget,
) => ({
  schema: sql(target.schemaName),
  view: sql(target.sessionsViewName),
})

const messagesRelation = (
  sql: MaterializeSql,
  target: RuntimeOutputProjectionTarget,
) => ({
  schema: sql(target.schemaName),
  view: sql(target.messagesViewName),
})

const contextFilter = (
  sql: MaterializeSql,
  contextId: string | undefined,
) =>
  contextId === undefined
    ? sql.literal("")
    : sql`WHERE "contextId" = ${contextId}`

const messageFilter = (
  sql: MaterializeSql,
  options: {
    readonly contextId?: string
    readonly sessionId?: string
  },
) => {
  if (options.contextId !== undefined && options.sessionId !== undefined) {
    return sql`WHERE "contextId" = ${options.contextId} AND "sessionId" = ${options.sessionId}`
  }
  if (options.contextId !== undefined) {
    return sql`WHERE "contextId" = ${options.contextId}`
  }
  if (options.sessionId !== undefined) {
    return sql`WHERE "sessionId" = ${options.sessionId}`
  }
  return sql.literal("")
}

const limitClause = (
  sql: MaterializeSql,
  limit: number | undefined,
) =>
  limit === undefined
    ? sql.literal("")
    : sql`LIMIT ${Math.max(0, Math.floor(limit))}`

export const materializeSessionProjectionSessionsQuery = (
  target: RuntimeOutputProjectionTarget,
  options: {
    readonly contextId?: string
    readonly limit?: number
  } = {},
): MaterializeQuery<SessionProjection> => ({
  statement: sql => {
    const { schema, view } = sessionsRelation(sql, target)
    const where = contextFilter(sql, options.contextId)
    const limit = limitClause(sql, options.limit)
    return sql`
SELECT *
FROM ${schema}.${view}
${where}
ORDER BY "contextId", "sessionId"
${limit}
`
  },
})

export const materializeSessionProjectionMessagesQuery = (
  target: RuntimeOutputProjectionTarget,
  options: {
    readonly contextId?: string
    readonly sessionId?: string
    readonly limit?: number
  } = {},
): MaterializeQuery<MessageProjection> => ({
  statement: sql => {
    const { schema, view } = messagesRelation(sql, target)
    const where = messageFilter(sql, options)
    const limit = limitClause(sql, options.limit)
    return sql`
SELECT *
FROM ${schema}.${view}
${where}
ORDER BY "contextId", "sessionId", "createdAt", "messageId"
${limit}
`
  },
})

export const materializeRuntimeEventsSubscribe = (
  target: RuntimeOutputProjectionTarget,
  options: {
    readonly contextId?: string
  } = {},
): MaterializeQuery<{
  readonly mz_timestamp: unknown
  readonly mz_diff: unknown
  readonly event_id: string
  readonly context_id: string
  readonly activity_attempt: number
  readonly sequence: number
  readonly raw: string
}> => {
  return {
    statement: sql => {
      const { schema, view } = runtimeEventsRelation(sql, target)
      const where = runtimeEventsContextFilter(sql, options.contextId)
      return sql`
SUBSCRIBE (
  SELECT event_id, context_id, activity_attempt, sequence, raw
  FROM ${schema}.${view}
  ${where}
)
`
    },
  }
}

export const materializeSessionProjectionMessagesSubscribe = (
  target: RuntimeOutputProjectionTarget,
  options: {
    readonly contextId?: string
    readonly sessionId?: string
  } = {},
): MaterializeQuery<MessageProjection & {
  readonly mz_timestamp: unknown
  readonly mz_diff: unknown
}> => ({
  statement: sql => {
    const { schema, view } = messagesRelation(sql, target)
    const where = messageFilter(sql, options)
    return sql`
SUBSCRIBE (
  SELECT *
  FROM ${schema}.${view}
  ${where}
)
`
  },
})

export const materializeSessionProjectionSessionsSubscribe = (
  target: RuntimeOutputProjectionTarget,
  options: {
    readonly contextId?: string
  } = {},
): MaterializeQuery<SessionProjection & {
  readonly mz_timestamp: unknown
  readonly mz_diff: unknown
}> => ({
  statement: sql => {
    const { schema, view } = sessionsRelation(sql, target)
    const where = contextFilter(sql, options.contextId)
    return sql`
SUBSCRIBE (
  SELECT *
  FROM ${schema}.${view}
  ${where}
)
`
  },
})

const postWebhook = (
  target: RuntimeOutputProjectionTarget,
  event: unknown,
): Effect.Effect<void, MaterializeProviderError> =>
  target.webhookUrl === undefined
    ? Effect.fail(mapError(
      "materialize.ingest.webhook-url",
      new Error("target has no webhookUrl; pass webhookBaseUrl when provisioning"),
    ))
    : Effect.tryPromise({
      try: async () => {
        const response = await fetch(target.webhookUrl!, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event),
        })
        if (!response.ok) {
          return Promise.reject(new Error(`Materialize webhook returned ${response.status}`))
        }
      },
      catch: cause => mapError("materialize.ingest.fetch", cause),
    })

export const MaterializeProviderLive = Layer.effect(
  MaterializeProvider,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return MaterializeProvider.of({
      name: provider,
      provisionRuntimeOutputProjection: plan =>
        Effect.suspend(() => {
          const [
            createSchema,
            createSource,
            createRuntimeEventsView,
            createSessionsView,
            createMessagesView,
          ] = provisionSql(plan, sql)
          return createSchema.pipe(
            Effect.zipRight(createSource),
            Effect.zipRight(createRuntimeEventsView),
            Effect.zipRight(createSessionsView),
            Effect.zipRight(createMessagesView),
            Effect.as(targetFor(plan)),
            Effect.mapError(cause => mapError("materialize.provision.sql", cause)),
          )
        }),
      ingestRuntimeJournal: (target, event: RuntimeJournalEvent) =>
        postWebhook(target, event),
      ingestJson: postWebhook,
      query: query =>
        query.statement(sql).pipe(
          Effect.map(rows => rows as ReadonlyArray<never>),
          Effect.mapError(cause => mapError("materialize.query", cause)),
        ),
      subscribe: query =>
        query.statement(sql).stream.pipe(
          Stream.map(row => row as never),
          Stream.mapError(cause => mapError("materialize.subscribe", cause)),
        ),
    })
  }),
)

export const MaterializeProviderPgLive = (
  config: PgClient.PgClientConfig,
) =>
  MaterializeProviderLive.pipe(
    Layer.provide(PgClient.layer(config)),
  )
