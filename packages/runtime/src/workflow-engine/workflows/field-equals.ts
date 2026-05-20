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

const traversePath = (row: unknown, path: ReadonlyArray<string>): unknown =>
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
