import type { RuntimeLaunchRequest } from "@firegrid/protocol/launch"
import { Effect } from "effect"
import { asLaunchError, type RuntimeLaunchError } from "./errors.ts"

export const commandForLaunch = (
  launch: RuntimeLaunchRequest,
): Effect.Effect<{ readonly argv: ReadonlyArray<string>; readonly cwd?: string }, RuntimeLaunchError> =>
  Effect.gen(function* () {
    if (launch.runtime.provider !== "local-process") {
      return yield* asLaunchError(
        "buildCommand",
        `unsupported runtime provider: ${launch.runtime.provider}`,
        launch.launchId,
      )
    }
    const [command] = launch.runtime.config.argv
    if (command === undefined) {
      return yield* asLaunchError("buildCommand", "launch runtime argv is empty", launch.launchId)
    }
    return {
      argv: [...launch.runtime.config.argv],
      ...(launch.runtime.config.cwd === undefined ? {} : { cwd: launch.runtime.config.cwd }),
    }
  })
