import { Console, Effect } from "effect"
import { runReplayHarness } from "./replay.ts"

export const agentRuntimeFixtureReplayDriver = runReplayHarness.pipe(
  Effect.tap(result =>
    Console.log(
      [
        `agent-runtime fixture replay matrix rows: ${result.matrixRows.length}`,
        `agent-runtime fixture replay fuzz cases: ${result.fuzzCases}`,
        `agent-runtime fixture replay unsupported rows: ${result.unsupportedRows.join(",")}`,
      ].join("\n"),
    )),
)
