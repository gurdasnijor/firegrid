import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { readJson } from "./files.ts"
import type { ArmScore } from "./types.ts"

export const compileFinding = async (runDir: string): Promise<void> => {
  const scoresPayload = await readJson<{ readonly scores: ReadonlyArray<ArmScore> }>(
    path.join(runDir, "scores.json"),
  )
  const task = await readFile(path.join(runDir, "task.md"), "utf8").catch(() => "")
  const rows = scoresPayload.scores.map(score =>
    `| ${score.arm} | ${score.summary?.status ?? "unknown"} | ${score.summary?.durationMs ?? 0} | ${score.trace?.spans ?? 0} | ${score.trace?.errorSpans ?? 0} | ${score.trace?.toolsCallSpans ?? 0} |`,
  )
  const blocked = scoresPayload.scores.filter(score => score.summary?.status === "blocked")
  await writeFile(
    path.join(runDir, "FINDING.md"),
    [
      "# Agent Coordination Patterns Experiment Finding",
      "",
      "Status: draft generated from run artifacts",
      "",
      "## Task Packet",
      "",
      "```text",
      task.trim(),
      "```",
      "",
      "## Arm Summary",
      "",
      "| Arm | Status | Duration ms | Spans | Trace errors | Tool-call spans |",
      "| --- | --- | ---: | ---: | ---: | ---: |",
      ...rows,
      "",
      "## Initial Interpretation",
      "",
      "- Treat this as a generated scaffold finding, not a final research conclusion.",
      "- Generic coordination conclusions require comparing successful arms on the same task packet.",
      "- Firegrid-specific implementation findings should be separated from generic coordination findings.",
      "",
      ...(blocked.length === 0
        ? []
        : [
          "## Blocked Arms",
          "",
          ...blocked.map(score => `- ${score.arm}: ${score.summary?.reason ?? "blocked"}`),
          "",
        ]),
      "## Acceptance Hooks",
      "",
      "- agent-coordination-patterns-experiment.ARTIFACTS.3",
      "",
    ].join("\n"),
    "utf8",
  )
}
