import { Option, SchemaAST, type Schema } from "effect"

export interface FiregridProjectionMetadata {
  readonly operationId: string
  readonly toolName?: string
  readonly clientName?: string
  readonly cliName?: string
}

export interface FiregridOperationEntry<
  InputSchema extends Schema.Schema.Any,
  OutputSchema extends Schema.Schema.Any,
> {
  readonly inputSchema: InputSchema
  readonly outputSchema: OutputSchema
  readonly metadata: FiregridProjectionMetadata
  readonly description: string
  readonly examples: ReadonlyArray<unknown>
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

const annotationString = (
  ast: SchemaAST.AST,
  annotationId: symbol,
): string | undefined => {
  const value = ast.annotations[annotationId]
  return typeof value === "string" ? value : undefined
}

const annotationExamples = (ast: SchemaAST.AST): ReadonlyArray<unknown> => {
  const value = ast.annotations[SchemaAST.ExamplesAnnotationId]
  return Array.isArray(value) ? value : []
}

export const defineFiregridOperation = <
  InputSchema extends Schema.Schema.Any,
  OutputSchema extends Schema.Schema.Any,
>(
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
): FiregridOperationEntry<InputSchema, OutputSchema> => {
  const metadata = Option.getOrThrow(getFiregridProjectionMetadata(inputSchema))
  return {
    inputSchema,
    outputSchema,
    metadata,
    description:
      annotationString(inputSchema.ast, SchemaAST.DescriptionAnnotationId) ??
      metadata.operationId,
    examples: annotationExamples(inputSchema.ast),
  }
}
