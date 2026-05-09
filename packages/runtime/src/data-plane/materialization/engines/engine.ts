import type { RuntimeJournalEvent } from "@firegrid/protocol/launch"
import type { Constructor, Statement } from "@effect/sql/Statement"
import type { Effect, Scope, Stream } from "effect"
import { Context, Schema } from "effect"

export class MaterializationEngineError extends Schema.TaggedError<MaterializationEngineError>()(
  "MaterializationEngineError",
  {
    engine: Schema.String,
    op: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export interface MaterializationQuery<A extends object = Record<string, unknown>> {
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
  readonly engine: string
  readonly sourceName: string
  readonly databaseName: string
  readonly schemaName: string
  readonly webhookUrl?: string
  readonly runtimeEventsViewName: string
}

export interface MaterializationEngineService {
  readonly name: string
  readonly provisionRuntimeOutput: (
    plan: RuntimeOutputProjectionPlan,
  ) => Effect.Effect<RuntimeOutputProjectionTarget, MaterializationEngineError>
  readonly ingestRuntimeJournal: (
    target: RuntimeOutputProjectionTarget,
    event: RuntimeJournalEvent,
  ) => Effect.Effect<void, MaterializationEngineError>
  readonly query: <A extends object = Record<string, unknown>>(
    query: MaterializationQuery<A>,
  ) => Effect.Effect<ReadonlyArray<A>, MaterializationEngineError>
  readonly subscribe: <A extends object = Record<string, unknown>>(
    query: MaterializationQuery<A>,
  ) => Stream.Stream<A, MaterializationEngineError, Scope.Scope>
}

export class MaterializationEngine extends Context.Tag("firegrid/runtime/MaterializationEngine")<
  MaterializationEngine,
  MaterializationEngineService
>() {}
