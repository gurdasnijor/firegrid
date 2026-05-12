export * from "@firegrid/protocol/runtime-ingress"
import { Schema } from "effect"

export class RuntimeIngressError extends Schema.TaggedError<RuntimeIngressError>()(
  "RuntimeIngressError",
  {
    op: Schema.String,
    contextId: Schema.optional(Schema.String),
    ingressId: Schema.optional(Schema.String),
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export const runtimeIngressError = (
  op: string,
  message: string,
  contextId?: string,
  ingressId?: string,
  cause?: unknown,
): RuntimeIngressError =>
  new RuntimeIngressError({
    op,
    message,
    ...(contextId === undefined ? {} : { contextId }),
    ...(ingressId === undefined ? {} : { ingressId }),
    ...(cause === undefined ? {} : { cause }),
  })
