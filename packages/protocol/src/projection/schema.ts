import { Option } from "effect"
import type { SchemaAST } from "effect"

export interface FiregridProjectionMetadata {
  readonly operationId: string
  readonly toolName?: string
  readonly clientName?: string
  readonly cliName?: string
}

export const FiregridProjectionAnnotationId: unique symbol = Symbol.for(
  "firegrid/annotation/Projection",
)

export const firegridProjection = (
  metadata: FiregridProjectionMetadata,
) => ({
  [FiregridProjectionAnnotationId]: metadata,
})

export const getFiregridProjectionMetadata = (
  schema: { readonly ast: SchemaAST.AST },
): Option.Option<FiregridProjectionMetadata> =>
  Option.fromNullable(
    schema.ast.annotations[FiregridProjectionAnnotationId] as
      | FiregridProjectionMetadata
      | undefined,
  )
