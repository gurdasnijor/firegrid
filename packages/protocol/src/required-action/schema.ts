import { Schema } from "effect"

export const RequiredActionOutcomeSchema = Schema.Literal(
  "approved",
  "denied",
  // firegrid-required-actions.WORKFLOW.6
  "timed_out",
  "cancelled",
  "failed",
)
export type RequiredActionOutcome = Schema.Schema.Type<typeof RequiredActionOutcomeSchema>

const RequiredActionRequestFields = {
  requiredActionId: Schema.String,
  runtimeContextId: Schema.String,
  requestKind: Schema.String,
  subject: Schema.Unknown,
  options: Schema.optional(Schema.Unknown),
  prompt: Schema.optional(Schema.Unknown),
  expiresAt: Schema.optional(Schema.String),
  workflowDeferredToken: Schema.optional(Schema.String),
}

/**
 * firegrid-required-actions.RECORDS.4
 * firegrid-required-actions.BOUNDARY.5
 */
export const RequiredActionRequestedRowSchema = Schema.Struct({
  type: Schema.Literal("firegrid.required_action.requested"),
  id: Schema.String,
  at: Schema.String,
  ...RequiredActionRequestFields,
})
export type RequiredActionRequestedRow = Schema.Schema.Type<
  typeof RequiredActionRequestedRowSchema
>

export const RequiredActionResolutionSchema = Schema.Struct({
  requiredActionId: Schema.String,
  outcome: RequiredActionOutcomeSchema,
  resolvedBy: Schema.String,
  resolvedAt: Schema.String,
  selectedOptionId: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
})
export type RequiredActionResolution = Schema.Schema.Type<
  typeof RequiredActionResolutionSchema
>

export const RequiredActionResolveRequestSchema = Schema.Struct({
  requiredActionId: Schema.String,
  outcome: RequiredActionOutcomeSchema,
  resolvedBy: Schema.String,
  resolvedAt: Schema.optional(Schema.String),
  selectedOptionId: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
})
export type RequiredActionResolveRequest = Schema.Schema.Type<
  typeof RequiredActionResolveRequestSchema
>

export const RequiredActionResolvedRowSchema = Schema.Struct({
  type: Schema.Literal("firegrid.required_action.resolved"),
  id: Schema.String,
  at: Schema.String,
  requiredActionId: Schema.String,
  resolution: RequiredActionResolutionSchema,
})
export type RequiredActionResolvedRow = Schema.Schema.Type<
  typeof RequiredActionResolvedRowSchema
>

export const RequiredActionRowSchema = Schema.Union(
  RequiredActionRequestedRowSchema,
  RequiredActionResolvedRowSchema,
)
export type RequiredActionRow = Schema.Schema.Type<typeof RequiredActionRowSchema>

export const RequiredActionRequestSchema = Schema.Struct(RequiredActionRequestFields)
export type RequiredActionRequest = Schema.Schema.Type<typeof RequiredActionRequestSchema>

export const RequiredActionStateSchema = Schema.Struct({
  requiredActionId: Schema.String,
  status: Schema.Union(Schema.Literal("requested"), RequiredActionOutcomeSchema),
  request: Schema.optional(RequiredActionRequestedRowSchema),
  resolution: Schema.optional(RequiredActionResolutionSchema),
})
export type RequiredActionState = Schema.Schema.Type<typeof RequiredActionStateSchema>
