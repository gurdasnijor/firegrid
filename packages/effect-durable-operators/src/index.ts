/**
 * effect-durable-operators
 *
 * Generic, Effect-native durable operators composed over
 * `effect-durable-streams`, `effect-durable-streams-state`,
 * `@durable-streams/state`, and `@tanstack/db`.
 *
 * See docs/proposals/SDD_EFFECT_DURABLE_OPERATORS.md and
 * docs/tracers/017-effect-durable-operators.md.
 */

export { DurableTable } from "./DurableTable.ts"
export type {
  CollectionFacade as DurableTableCollectionFacade,
  DurableTableService,
  DurableTableTagClass,
  LayerOptions as DurableTableLayerOptions,
  PrimaryKeyOf as DurableTablePrimaryKeyOf,
  RowOf as DurableTableRowOf,
} from "./DurableTable.ts"
export * as DurableProjection from "./DurableProjection.ts"
export * as DurableConsumer from "./DurableConsumer.ts"
export * as ConsumerSource from "./ConsumerSource.ts"
export { ConsumerCheckpointStore, ConsumerCheckpointStoreLive } from "./ConsumerCheckpointStore.ts"
export type { CheckpointRecord } from "./ConsumerCheckpointStore.ts"
export { ClaimPolicy } from "./DurableConsumer.ts"
export type { ClaimPolicyType } from "./DurableConsumer.ts"
export {
  CheckpointError,
  DurableConsumerError,
  DurableProjectionError,
  DurableTableError,
} from "./Errors.ts"
