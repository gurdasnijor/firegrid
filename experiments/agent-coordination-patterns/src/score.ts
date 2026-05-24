import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { readJson, writeJson } from "./files.ts"
import type { ArmScore, ArmSummary, TraceScore } from "./types.ts"

const parseTraceLine = (line: string): unknown | undefined => {
  try {
    return JSON.parse(line) as unknown
  } catch {
    return undefined
  }
}

const textOf = (value: unknown): string =>
  JSON.stringify(value)

const scoreTrace = async (tracePath: string): Promise<TraceScore> => {
  const text = await readFile(tracePath, "utf8").catch(() => "")
  const lines = text.split(/\r?\n/u).filter(Boolean)
  let errorSpans = 0
  let agentSilentErrors = 0
  let unknownChannelErrors = 0
  let toolsCallSpans = 0
  let permissionRequestSpans = 0
  let sessionAgentOutputSpans = 0

  for (const line of lines) {
    const parsed = parseTraceLine(line)
    const serialized = textOf(parsed)
    if (serialized.includes("\"status\":{\"code\":2") || serialized.includes("\"level\":\"ERROR\"")) {
      errorSpans += 1
    }
    if (serialized.includes("agent_silent")) agentSilentErrors += 1
    if (serialized.includes("UnknownChannelTarget") || serialized.includes("unknown-channel")) {
      unknownChannelErrors += 1
    }
    if (serialized.includes("tools/call")) toolsCallSpans += 1
    if (serialized.includes("permission_request")) permissionRequestSpans += 1
    if (serialized.includes("session_agent_output") || serialized.includes("session.agent_output")) {
      sessionAgentOutputSpans += 1
    }
  }

  return {
    spans: lines.length,
    errorSpans,
    agentSilentErrors,
    unknownChannelErrors,
    toolsCallSpans,
    permissionRequestSpans,
    sessionAgentOutputSpans,
  }
}

export const scoreRun = async (runDir: string): Promise<ReadonlyArray<ArmScore>> => {
  const armsDir = path.join(runDir, "arms")
  const arms = await readdir(armsDir).catch(() => [])
  const scores: Array<ArmScore> = []
  for (const arm of arms) {
    const armDir = path.join(armsDir, arm)
    const summary = await readJson<ArmSummary>(path.join(armDir, "summary.json"))
      .catch(() => undefined)
    const trace = await scoreTrace(path.join(armDir, "trace.jsonl"))
    const score: ArmScore = {
      arm,
      ...(summary === undefined ? {} : { summary }),
      trace,
    }
    scores.push(score)
    await writeJson(path.join(armDir, "score.json"), score)
  }
  await writeJson(path.join(runDir, "scores.json"), {
    "agent-coordination-patterns-experiment.ARTIFACTS.2": true,
    scores,
  })
  return scores
}

export const writeScoreMarkdown = async (
  runDir: string,
  scores: ReadonlyArray<ArmScore>,
): Promise<void> => {
  const rows = scores.map(score =>
    `| ${score.arm} | ${score.summary?.status ?? "unknown"} | ${score.trace?.spans ?? 0} | ${score.trace?.errorSpans ?? 0} | ${score.trace?.toolsCallSpans ?? 0} | ${score.trace?.agentSilentErrors ?? 0} | ${score.trace?.unknownChannelErrors ?? 0} |`,
  )
  await writeFile(
    path.join(runDir, "SCORE.md"),
    [
      "# Agent Coordination Pattern Scores",
      "",
      "| Arm | Status | Spans | Errors | Tool Calls | agent_silent | unknown-channel |",
      "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
      ...rows,
      "",
    ].join("\n"),
    "utf8",
  )
}
