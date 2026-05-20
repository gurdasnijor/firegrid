import { Option, SchemaAST, type Schema } from "effect"
import { getFiregridProjectionMetadata } from "../projection/schema.ts"
import type { FiregridProjectionMetadata } from "../projection/schema.ts"

export {
  FiregridProjectionAnnotationId,
  firegridProjection,
  getFiregridProjectionMetadata,
  type FiregridProjectionMetadata,
} from "../projection/schema.ts"

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
