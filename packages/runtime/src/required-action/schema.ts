export * from "@firegrid/protocol/required-action"
import { Schema } from "effect"

export class RequiredActionError extends Schema.TaggedError<RequiredActionError>()(
  "RequiredActionError",
  {
    op: Schema.String,
    requiredActionId: Schema.optional(Schema.String),
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export const requiredActionError = (
  op: string,
  message: string,
  requiredActionId?: string,
  cause?: unknown,
): RequiredActionError =>
  new RequiredActionError({
    op,
    message,
    ...(requiredActionId === undefined ? {} : { requiredActionId }),
    ...(cause === undefined ? {} : { cause }),
  })
