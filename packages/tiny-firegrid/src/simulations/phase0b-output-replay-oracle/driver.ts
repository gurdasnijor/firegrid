import { Console, Effect } from "effect"
import { phase0bOracleResult } from "./host.ts"

export const phase0bOracleDriver = Effect.tryPromise({
  try: () => phase0bOracleResult,
  catch: error => error,
}).pipe(
  Effect.tap(result =>
    Console.log(
      [
        `phase0b output-replay oracle: ${result.verdict}`,
        `  threshold (reads/output) <= ${result.threshold}`,
        `  specimen  D=${result.primaryDistinctOutputs}: amplification=${
          result.specimen.amplification.toFixed(2)
        } logReads=${result.specimen.logReads} O(outputs)=${result.specimen.oOutputs}`,
        `  candidate D=${result.primaryDistinctOutputs}: amplification=${
          result.candidate.amplification.toFixed(2)
        } logReads=${result.candidate.logReads} O(outputs)=${result.candidate.oOutputs}`,
        "  sweep (D: specimen|candidate amplification):",
        ...result.sweep.map(p =>
          `    ${String(p.distinctOutputs).padStart(3)}: ${
            p.specimenAmplification.toFixed(2)
          } | ${p.candidateAmplification.toFixed(2)}`,
        ),
      ].join("\n"),
    ),
  ),
)
