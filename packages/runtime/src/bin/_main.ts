import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { programExitCode, renderError } from "./_resolve.ts"

export const runFiregridBinMain = (
  program: Effect.Effect<void, unknown, never>,
): void => {
  NodeRuntime.runMain(
    program.pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          process.stderr.write(`${renderError(error)}\n`)
          process.exitCode = programExitCode(error)
        })),
    ),
    { disablePrettyLogger: true },
  )
}
