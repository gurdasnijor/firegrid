import type { Constructor, Statement } from "@effect/sql/Statement"
import type { RuntimeJournalEvent } from "@firegrid/protocol/launch"
import type { Effect, Scope, Stream } from "effect"
import { Context, Schema } from "effect"

export class MaterializeProviderError extends Schema.TaggedError<MaterializeProviderError>()(
  "MaterializeProviderError",
  {
    provider: Schema.String,
    op: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export interface MaterializeQuery<A extends object = Record<string, unknown>> {
  readonly statement: (sql: Constructor) => Statement<A>
  readonly _tag?: (_: never) => A
}

export interface RuntimeOutputProjectionPlan {
  readonly sourceName: string
  readonly databaseName?: string
  readonly schemaName?: string
  readonly webhookBaseUrl?: string
}

export interface RuntimeOutputProjectionTarget {
  readonly provider: string
  readonly sourceName: string
  readonly databaseName: string
  readonly schemaName: string
  readonly webhookUrl?: string
  readonly runtimeEventsViewName: string
}

export interface MaterializeProviderService {
  readonly name: string
  readonly provisionRuntimeOutputProjection: (
    plan: RuntimeOutputProjectionPlan,
  ) => Effect.Effect<RuntimeOutputProjectionTarget, MaterializeProviderError>
  readonly ingestRuntimeJournal: (
    target: RuntimeOutputProjectionTarget,
    event: RuntimeJournalEvent,
  ) => Effect.Effect<void, MaterializeProviderError>
  readonly query: <A extends object = Record<string, unknown>>(
    query: MaterializeQuery<A>,
  ) => Effect.Effect<ReadonlyArray<A>, MaterializeProviderError>
  readonly subscribe: <A extends object = Record<string, unknown>>(
    query: MaterializeQuery<A>,
  ) => Stream.Stream<A, MaterializeProviderError, Scope.Scope>
}

export class MaterializeProvider extends Context.Tag("firegrid/runtime/MaterializeProvider")<
  MaterializeProvider,
  MaterializeProviderService
>() {}

