import { Clock, Duration, Effect, Option, Schema, Stream } from "effect"
import { FactoryRunKeyStringSchema } from "./identity.ts"
import {
  factoryPermissionProjectionFromFact,
  factoryPhaseProjectionFromFact,
  factoryProviderEffectProjectionFromFact,
  type FactoryPermissionProjection,
  type FactoryPhaseProjection,
  type FactoryProviderEffectProjection,
  type FactoryRunProjection,
  type PermissionDecisionTag,
} from "./projections.ts"
import {
  DarkFactoryRunStatusSchema,
  DarkFactoryTable,
} from "./tables.ts"

export const FactoryRunStatusWaitOptionsSchema = Schema.Struct({
  factoryRunKey: FactoryRunKeyStringSchema,
  status: DarkFactoryRunStatusSchema,
  timeoutMs: Schema.Number,
})
export type FactoryRunStatusWaitOptions = Schema.Schema.Type<
  typeof FactoryRunStatusWaitOptionsSchema
>

export const FactoryPhaseProjectionWaitOptionsSchema = Schema.Struct({
  factoryRunKey: FactoryRunKeyStringSchema,
  phase: Schema.String.pipe(Schema.minLength(1)),
  timeoutMs: Schema.Number,
})
export type FactoryPhaseProjectionWaitOptions = Schema.Schema.Type<
  typeof FactoryPhaseProjectionWaitOptionsSchema
>

export const FactoryPermissionResolutionWaitOptionsSchema = Schema.Struct({
  factoryRunKey: FactoryRunKeyStringSchema,
  permissionRequestId: Schema.String.pipe(Schema.minLength(1)),
  decisions: Schema.optional(Schema.Array(Schema.Literal("Allow", "Deny", "Cancelled"))),
  timeoutMs: Schema.Number,
})
export type FactoryPermissionResolutionWaitOptions = Schema.Schema.Type<
  typeof FactoryPermissionResolutionWaitOptionsSchema
>

export const FactoryProviderEffectWaitOptionsSchema = Schema.Struct({
  factoryRunKey: FactoryRunKeyStringSchema,
  effectType: Schema.String.pipe(Schema.minLength(1)),
  externalEventKey: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  status: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  timeoutMs: Schema.Number,
})
export type FactoryProviderEffectWaitOptions = Schema.Schema.Type<
  typeof FactoryProviderEffectWaitOptionsSchema
>

const runHeadWithTimeout = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
  timeoutMs: number,
  description: string,
): Effect.Effect<A, E | Error, R> =>
  Effect.flatMap(
    Effect.raceFirst(
      Stream.runHead(stream),
      Clock.sleep(Duration.millis(timeoutMs)).pipe(
        Effect.as(Option.none<A>()),
      ),
    ),
    Option.match({
      onNone: () => Effect.fail(new Error(`timed out waiting for ${description}`)),
      onSome: Effect.succeed,
    }),
  )

export const waitForFactoryRunStatus = (
  options: FactoryRunStatusWaitOptions,
): Effect.Effect<FactoryRunProjection, unknown, unknown> =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknown(FactoryRunStatusWaitOptionsSchema)(
      options,
    )
    const table = yield* DarkFactoryTable
    return yield* runHeadWithTimeout(
      table.runs.rows().pipe(
        Stream.filter(row =>
          row.factoryRunKey === decoded.factoryRunKey &&
          row.status === decoded.status,
        ),
      ),
      decoded.timeoutMs,
      `factory run ${decoded.factoryRunKey} status ${decoded.status}`,
    )
  })

export const waitForFactoryPhaseProjection = (
  options: FactoryPhaseProjectionWaitOptions,
): Effect.Effect<FactoryPhaseProjection, unknown, unknown> =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknown(FactoryPhaseProjectionWaitOptionsSchema)(
      options,
    )
    const table = yield* DarkFactoryTable
    return yield* runHeadWithTimeout(
      table.facts.rows().pipe(
        Stream.filterMap(factoryPhaseProjectionFromFact),
        Stream.filter(projection =>
          projection.factoryRunKey === decoded.factoryRunKey &&
          projection.phase === decoded.phase,
        ),
      ),
      decoded.timeoutMs,
      `factory phase ${decoded.factoryRunKey}:${decoded.phase}`,
    )
  })

export const waitForFactoryPermissionResolution = (
  options: FactoryPermissionResolutionWaitOptions,
): Effect.Effect<FactoryPermissionProjection, unknown, unknown> =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknown(
      FactoryPermissionResolutionWaitOptionsSchema,
    )(options)
    const decisions = new Set<PermissionDecisionTag>(decoded.decisions ?? [])
    const table = yield* DarkFactoryTable
    return yield* runHeadWithTimeout(
      table.facts.rows().pipe(
        Stream.filterMap(factoryPermissionProjectionFromFact),
        Stream.filter(projection =>
          projection.factoryRunKey === decoded.factoryRunKey &&
          projection.permissionRequestId === decoded.permissionRequestId &&
          (decisions.size === 0 || decisions.has(projection.decision._tag)),
        ),
      ),
      decoded.timeoutMs,
      `factory permission ${decoded.factoryRunKey}:${decoded.permissionRequestId}`,
    )
  })

export const waitForFactoryProviderEffect = (
  options: FactoryProviderEffectWaitOptions,
): Effect.Effect<FactoryProviderEffectProjection, unknown, unknown> =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknown(FactoryProviderEffectWaitOptionsSchema)(
      options,
    )
    const table = yield* DarkFactoryTable
    return yield* runHeadWithTimeout(
      table.facts.rows().pipe(
        Stream.filterMap(factoryProviderEffectProjectionFromFact),
        Stream.filter(projection =>
          projection.factoryRunKey === decoded.factoryRunKey &&
          projection.effectType === decoded.effectType &&
          (decoded.externalEventKey === undefined ||
            projection.externalEventKey === decoded.externalEventKey) &&
          (decoded.status === undefined || projection.status === decoded.status),
        ),
      ),
      decoded.timeoutMs,
      `factory provider effect ${decoded.factoryRunKey}:${decoded.effectType}`,
    )
  })
