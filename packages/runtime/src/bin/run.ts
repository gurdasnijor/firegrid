import { Effect } from "effect"
import { pathToFileURL } from "node:url"
import { FiregridCliUsageError } from "./_compose.ts"
import { runFiregridBinMain } from "./_main.ts"

const usage = [
  "Usage: firegrid run [options] -- <agent-argv>",
  "firegrid run is not rebuilt in this slice; use firegrid acp for the ACP stdio server.",
].join("\n")

export const runProgram = (
  _argv: ReadonlyArray<string>,
): Effect.Effect<void, FiregridCliUsageError> =>
  Effect.fail(new FiregridCliUsageError({ message: usage }))

export const runFiregridRunMain = (
  argv: ReadonlyArray<string> = process.argv.slice(2),
): void => {
  runFiregridBinMain(runProgram(argv))
}

const isDirectRun = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url

if (isDirectRun) {
  runFiregridRunMain()
}
