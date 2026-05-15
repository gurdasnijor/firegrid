import { Effect, Schema } from "effect"

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

export const mapRuntimeContextError = <E>(
  op: string,
  message: string,
  contextId: string,
) =>
  Effect.mapError((cause: E) =>
    asRuntimeContextError(op, message, contextId, cause))

export class RuntimeIngressError extends Schema.TaggedError<RuntimeIngressError>()(
  "RuntimeIngressError",
  {
    op: Schema.String,
    contextId: Schema.optional(Schema.String),
    inputId: Schema.optional(Schema.String),
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export const runtimeIngressError = (
  op: string,
  message: string,
  contextId?: string,
  inputId?: string,
  cause?: unknown,
): RuntimeIngressError =>
  new RuntimeIngressError({
    op,
    message,
    ...(contextId === undefined ? {} : { contextId }),
    ...(inputId === undefined ? {} : { inputId }),
    ...(cause === undefined ? {} : { cause }),
  })
