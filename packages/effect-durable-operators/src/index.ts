/**
 * effect-durable-operators
 *
 * Effect-native durable operators on top of `@durable-streams/state` and
 * `@tanstack/db`. The public surface is intentionally minimal:
 *
 *   - DurableTable: ksql-inspired service-tag table with generated
 *     insert/upsert/delete/get/query/subscribe facades over createStreamDB.
 *   - DurableTable.primaryKey: a Schema.transform/annotation helper that pins
 *     a struct field's encoded form to string and marks it for AST discovery.
 *   - DurableTableError: the typed error for the table primitive.
 *
 * See docs/proposals/SDD_EFFECT_DURABLE_OPERATORS.md.
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
export { DurableTableError } from "./Errors.ts"
