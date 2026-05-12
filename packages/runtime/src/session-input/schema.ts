export * from "@firegrid/protocol/session-input"
import { Schema } from "effect"

export class SessionInputError extends Schema.TaggedError<SessionInputError>()(
  "SessionInputError",
  {
    op: Schema.String,
    contextId: Schema.optional(Schema.String),
    sessionInputId: Schema.optional(Schema.String),
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export const sessionInputError = (
  op: string,
  message: string,
  contextId?: string,
  sessionInputId?: string,
  cause?: unknown,
): SessionInputError =>
  new SessionInputError({
    op,
    message,
    ...(contextId === undefined ? {} : { contextId }),
    ...(sessionInputId === undefined ? {} : { sessionInputId }),
    ...(cause === undefined ? {} : { cause }),
  })
