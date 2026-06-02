// Pure field-equals predicate / trigger evaluator.
//
// Logical pipeline position: transforms/ (peer of producers, channels).
// Pure: no Effect, no Layer, no Context.Tag, no I/O. The evaluator works on
// any unknown row value and is callable in a unit test with no Effect
// environment (see docs/cannon/architecture/runtime-pipeline-type-boundaries.md
// §"Enforcement Checklist" item 7).
//
// Moved here from `workflow-engine/workflows/field-equals.ts` under the
// Shape C cutover physical target tree
// (docs/architecture/2026-05-22-runtime-physical-target-tree.md). The
// workflow-engine path keeps a thin re-export shim until callers migrate.

import { Schema } from "effect"

export const FieldEqualsPredicateSchema = Schema.Struct({
  path: Schema.Array(Schema.String),
  equals: Schema.Union(Schema.String, Schema.Number, Schema.Boolean),
})

export type FieldEqualsPredicate = Schema.Schema.Type<
  typeof FieldEqualsPredicateSchema
>

export const FieldEqualsTriggerSchema = Schema.Array(FieldEqualsPredicateSchema)

export type FieldEqualsTrigger = Schema.Schema.Type<
  typeof FieldEqualsTriggerSchema
>

export const traversePath = (row: unknown, path: ReadonlyArray<string>): unknown =>
  path.reduce<unknown>((cursor, segment) =>
    typeof cursor === "object" && cursor !== null
      ? (cursor as Record<string, unknown>)[segment]
      : undefined,
    row,
  )

export const evaluateFieldEquals = (
  trigger: FieldEqualsTrigger,
  row: unknown,
): boolean => {
  if (typeof row !== "object" || row === null) return false
  return trigger.every((predicate) =>
    traversePath(row, predicate.path) === predicate.equals)
}
