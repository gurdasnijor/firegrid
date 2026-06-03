
import { Schema } from "effect"

export class RuntimeIngressAgentInputTransformError extends Schema.TaggedError<
  RuntimeIngressAgentInputTransformError
>()("RuntimeIngressAgentInputTransformError", {
  op: Schema.String,
  contextId: Schema.String,
  inputId: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}
