import type { RuntimeContext } from "@firegrid/protocol/launch"
import { Effect } from "effect"
import { asRuntimeContextError, type RuntimeContextError } from "../../runtime-errors.ts"
import {
  resolveSpawnEnvVars,
  type RuntimeEnvResolverPolicy,
} from "./secrets.ts"

// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5
// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6
//
// Translates a durable RuntimeContext row into the SandboxCommand shape.
// envBindings are resolved here — at the provider boundary — through the
// RuntimeEnvResolverPolicy service so secret values never enter the durable
// plane. The policy gates which env refs are eligible; unauthorized refs
// fail loudly before any spawn.
export const commandForContext = (
  context: RuntimeContext,
): Effect.Effect<
  {
    readonly argv: ReadonlyArray<string>
    readonly cwd?: string
    readonly envVars?: Record<string, string>
  },
  RuntimeContextError,
  RuntimeEnvResolverPolicy
> =>
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
    const bindings = context.runtime.config.envBindings ?? []
    const envVars = bindings.length === 0
      ? undefined
      : yield* resolveSpawnEnvVars(bindings).pipe(
        Effect.mapError(cause =>
          asRuntimeContextError(
            "buildCommand.resolveEnvBindings",
            cause.message,
            context.contextId,
            cause,
          )),
      )
    return {
      argv: [...context.runtime.config.argv],
      ...(context.runtime.config.cwd === undefined ? {} : { cwd: context.runtime.config.cwd }),
      ...(envVars === undefined ? {} : { envVars }),
    }
  })
