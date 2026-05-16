import {
  RuntimeIngressTable,
  type RuntimeIngressDeliveryRow,
  type RuntimeIngressInputRow,
} from "@firegrid/protocol/runtime-ingress"
import { Context, Effect, Layer, Option } from "effect"
import type { Stream } from "effect"
import {
  runtimeSubscriberId as makeRuntimeSubscriberId,
  type RuntimeSubscriberId,
} from "../events/index.ts"
import { authorityNowIso } from "./time.ts"

export interface RuntimeIngressDeliveryClaimAndCompleteService {
  readonly claimInput: (
    row: RuntimeIngressInputRow,
    options: {
      readonly subscriberId: RuntimeSubscriberId
    },
  ) => Effect.Effect<Option.Option<RuntimeIngressDeliveryRow>, unknown>
  readonly recordCompleted: (
    delivery: RuntimeIngressDeliveryRow,
  ) => Effect.Effect<RuntimeIngressDeliveryRow, unknown>
}

const runtimeIngressSubscriberId = (
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

const runtimeIngressDeliveries = (
  table: RuntimeIngressTable["Type"],
): Stream.Stream<RuntimeIngressDeliveryRow, unknown> => table.deliveries.rows()

const serviceFromTable = (
  table: RuntimeIngressTable["Type"],
): RuntimeIngressDeliveryClaimAndCompleteService => ({
  claimInput: (row, options) => claimInputTo(table, row, options),
  recordCompleted: delivery => recordCompletedTo(table, delivery),
})

export class RuntimeIngressDeliveryClaimAndComplete extends Context.Tag(
  "@firegrid/runtime/RuntimeIngressDeliveryClaimAndComplete",
)<RuntimeIngressDeliveryClaimAndComplete, RuntimeIngressDeliveryClaimAndCompleteService>() {}

export class RuntimeIngressDeliveries extends Context.Tag(
  "@firegrid/runtime/RuntimeIngressDeliveries",
)<RuntimeIngressDeliveries, Stream.Stream<RuntimeIngressDeliveryRow, unknown>>() {}

export const RuntimeIngressDeliveryTrackerLayer = Layer.mergeAll(
  Layer.effect(
    RuntimeIngressDeliveryClaimAndComplete,
    Effect.map(RuntimeIngressTable, serviceFromTable),
  ),
  Layer.effect(
    RuntimeIngressDeliveries,
    Effect.map(RuntimeIngressTable, runtimeIngressDeliveries),
  ),
)

export { runtimeIngressSubscriberId }
