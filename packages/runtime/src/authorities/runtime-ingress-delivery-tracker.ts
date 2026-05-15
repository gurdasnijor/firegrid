import {
  RuntimeIngressTable,
  type RuntimeIngressDeliveryRow,
  type RuntimeIngressInputRow,
} from "@firegrid/protocol/runtime-ingress"
import { Context, Effect, Layer, Option } from "effect"
import {
  runtimeSubscriberId as makeRuntimeSubscriberId,
  type RuntimeAuthority,
  type RuntimeAuthorityCommand,
  type RuntimeAuthorityRead,
  type RuntimeSubscriberId,
} from "../events/index.ts"
import { sourceCollectionHandle } from "../waits/internal/source-collections.ts"
import { RuntimeAuthoritySourceNames } from "./source-names.ts"
import { authorityNowIso } from "./time.ts"

interface RuntimeIngressDeliveryWrites {
  readonly claimInput: (
    row: RuntimeIngressInputRow,
    options: {
      readonly subscriberId: RuntimeSubscriberId
    },
  ) => Effect.Effect<Option.Option<RuntimeIngressDeliveryRow>, unknown>
  readonly recordCompleted: RuntimeAuthorityCommand<RuntimeIngressDeliveryRow, RuntimeIngressDeliveryRow, unknown>
}

interface RuntimeIngressDeliveryReads {
  readonly deliveries: RuntimeAuthorityRead
}

export type RuntimeIngressDeliveryAuthorityService = RuntimeAuthority<
  RuntimeIngressDeliveryWrites,
  RuntimeIngressDeliveryReads
>

export class RuntimeIngressDeliveryAuthority extends Context.Tag(
  "@firegrid/runtime/RuntimeIngressDeliveryAuthority",
)<RuntimeIngressDeliveryAuthority, RuntimeIngressDeliveryAuthorityService>() {}

export const runtimeIngressSubscriberId = (
  protocol: string,
  role: string,
): RuntimeSubscriberId => makeRuntimeSubscriberId(`runtime-ingress:${protocol}:${role}`)

const claimInputTo = (
  table: RuntimeIngressTable["Type"],
  row: RuntimeIngressInputRow,
  options: {
    readonly subscriberId: RuntimeSubscriberId
  },
) =>
  Effect.gen(function* () {
    const key = {
      subscriberId: options.subscriberId,
      inputId: row.inputId,
    }
    const existing = yield* table.deliveries.get(key)
    if (
      Option.isSome(existing) &&
      existing.value.claimedAt !== undefined
    ) {
      return Option.none<RuntimeIngressDeliveryRow>()
    }

    const delivery: RuntimeIngressDeliveryRow = {
      key,
      inputId: row.inputId,
      contextId: row.contextId,
      subscriberId: options.subscriberId,
      claimedAt: yield* authorityNowIso,
    }
    yield* table.deliveries.upsert(delivery)
    return Option.some(delivery)
  })

const claimInput = (
  row: RuntimeIngressInputRow,
  options: {
    readonly subscriberId: RuntimeSubscriberId
  },
) =>
  Effect.flatMap(RuntimeIngressTable, table => claimInputTo(table, row, options))

const recordCompletedTo = (
  table: RuntimeIngressTable["Type"],
  delivery: RuntimeIngressDeliveryRow,
) =>
  Effect.gen(function* () {
    const completed: RuntimeIngressDeliveryRow = {
      ...delivery,
      completedAt: yield* authorityNowIso,
    }
    yield* table.deliveries.upsert(completed)
    return completed
  })

const recordCompleted = (
  delivery: RuntimeIngressDeliveryRow,
) =>
  Effect.flatMap(RuntimeIngressTable, table => recordCompletedTo(table, delivery))

const sources = (
  table: RuntimeIngressTable["Type"],
) => ({
  deliveries: sourceCollectionHandle(
    RuntimeAuthoritySourceNames.runtimeIngressDeliveries,
    table.deliveries,
  ),
}) as const

const authority = (
  table: RuntimeIngressTable["Type"],
): RuntimeIngressDeliveryAuthorityService => ({
  write: {
    claimInput: (row, options) => claimInputTo(table, row, options),
    recordCompleted: delivery => recordCompletedTo(table, delivery),
  },
  read: sources(table),
})

const layer = Layer.effect(
  RuntimeIngressDeliveryAuthority,
  Effect.map(RuntimeIngressTable, authority),
)

export const RuntimeIngressDeliveryTracker = {
  authority,
  layer,
  claimInput,
  claimInputTo,
  recordCompleted,
  recordCompletedTo,
  runtimeIngressSubscriberId,
  sources,
} as const
