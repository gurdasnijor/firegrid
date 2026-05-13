import type { RuntimeContext } from "@firegrid/protocol/launch"
import { Effect } from "effect"
import { asRuntimeContextError, type RuntimeContextError } from "../../runtime-host/errors.ts"

export const commandForContext = (
  context: RuntimeContext,
): Effect.Effect<{ readonly argv: ReadonlyArray<string>; readonly cwd?: string }, RuntimeContextError> =>
  Effect.gen(function* () {
    if (context.runtime.provider !== "local-process") {
      return yield* asRuntimeContextError(
        "buildCommand",
        `unsupported runtime provider: ${context.runtime.provider}`,
        context.contextId,
      )
    }
    const [command] = context.runtime.config.argv
    if (command === undefined) {
      return yield* asRuntimeContextError("buildCommand", "runtime argv is empty", context.contextId)
    }
    return {
      argv: [...context.runtime.config.argv],
      ...(context.runtime.config.cwd === undefined ? {} : { cwd: context.runtime.config.cwd }),
    }
  })
