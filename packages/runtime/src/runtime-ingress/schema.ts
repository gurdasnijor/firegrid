import { Schema } from "effect"

export const RuntimeIngressKindSchema = Schema.Literal(
  "message",
  "control",
  "tool_result",
  "required_action_result",
)
export type RuntimeIngressKind = Schema.Schema.Type<typeof RuntimeIngressKindSchema>

export const RuntimeIngressAuthorSchema = Schema.Literal(
  "client",
  "workflow",
  "tool",
  "system",
)
export type RuntimeIngressAuthor = Schema.Schema.Type<typeof RuntimeIngressAuthorSchema>

export const RuntimeIngressRequestSchema = Schema.Struct({
  ingressId: Schema.optional(Schema.String),
  contextId: Schema.String,
  kind: RuntimeIngressKindSchema,
  authoredBy: RuntimeIngressAuthorSchema,
  payload: Schema.Unknown,
  idempotencyKey: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record({
    key: Schema.String,
    value: Schema.String,
  })),
})
export type RuntimeIngressRequest = Schema.Schema.Type<typeof RuntimeIngressRequestSchema>

export const RuntimeIngressRequestedRowSchema = Schema.Struct({
  type: Schema.Literal("firegrid.runtime_ingress.requested"),
  id: Schema.String,
  at: Schema.String,
  ingressId: Schema.String,
  contextId: Schema.String,
  kind: RuntimeIngressKindSchema,
  authoredBy: RuntimeIngressAuthorSchema,
  payload: Schema.Unknown,
  idempotencyKey: Schema.optional(Schema.String),
  createdAt: Schema.String,
  metadata: Schema.optional(Schema.Record({
    key: Schema.String,
    value: Schema.String,
  })),
})
export type RuntimeIngressRequestedRow = Schema.Schema.Type<
  typeof RuntimeIngressRequestedRowSchema
>

export const RuntimeIngressDeliveryRequestSchema = Schema.Struct({
  contextId: Schema.String,
  ingressId: Schema.String,
  subscriberId: Schema.String,
  provider: Schema.String,
  deliveredAt: Schema.optional(Schema.String),
})
export type RuntimeIngressDeliveryRequest = Schema.Schema.Type<
  typeof RuntimeIngressDeliveryRequestSchema
>

export const RuntimeIngressDeliveredRowSchema = Schema.Struct({
  type: Schema.Literal("firegrid.runtime_ingress.delivered"),
  id: Schema.String,
  at: Schema.String,
  ingressId: Schema.String,
  contextId: Schema.String,
  subscriberId: Schema.String,
  provider: Schema.String,
  deliveredAt: Schema.String,
})
export type RuntimeIngressDeliveredRow = Schema.Schema.Type<
  typeof RuntimeIngressDeliveredRowSchema
>

export const RuntimeIngressRowSchema = Schema.Union(
  RuntimeIngressRequestedRowSchema,
  RuntimeIngressDeliveredRowSchema,
)
export type RuntimeIngressRow = Schema.Schema.Type<typeof RuntimeIngressRowSchema>

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
