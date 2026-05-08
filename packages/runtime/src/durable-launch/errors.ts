import { Effect, Schema } from "effect"

export class RuntimeLaunchError extends Schema.TaggedError<RuntimeLaunchError>()(
  "RuntimeLaunchError",
  {
    op: Schema.String,
    message: Schema.String,
    launchId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export const asLaunchError = (
  op: string,
  message: string,
  launchId?: string,
  cause?: unknown,
): RuntimeLaunchError =>
  new RuntimeLaunchError({
    op,
    message,
    ...(launchId === undefined ? {} : { launchId }),
    ...(cause === undefined ? {} : { cause }),
  })

export const mapLaunchError = (
  op: string,
  message: string,
  launchId: string,
) =>
<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, RuntimeLaunchError, R> =>
  effect.pipe(
    Effect.mapError(cause => asLaunchError(op, message, launchId, cause)),
  )
