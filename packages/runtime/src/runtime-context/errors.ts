import { Schema } from "effect"

export class RuntimeContextError extends Schema.TaggedError<RuntimeContextError>()(
  "RuntimeContextError",
  {
    op: Schema.String,
    message: Schema.String,
    contextId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export const asRuntimeContextError = (
  op: string,
  message: string,
  contextId?: string,
  cause?: unknown,
): RuntimeContextError =>
  new RuntimeContextError({
    op,
    message,
    ...(contextId === undefined ? {} : { contextId }),
    ...(cause === undefined ? {} : { cause }),
  })
