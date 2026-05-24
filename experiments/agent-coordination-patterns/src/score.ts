import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { readJson, writeJson } from "./files.ts"
import type { ArmScore, ArmSummary, BoardScore, TraceScore } from "./types.ts"
import type { CoordinationBoardRow } from "./app/coordination-board.ts"

const parseTraceLine = (line: string): unknown | undefined => {
  try {
    return JSON.parse(line) as unknown
  } catch {
    return undefined
  }
}

const textOf = (value: unknown): string =>
  JSON.stringify(value)

const isClientClosedSpan = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false
  const attributes = (value as { readonly attributes?: unknown }).attributes
  return typeof attributes === "object" && attributes !== null &&
    (attributes as { readonly ["http.response.status_code"]?: unknown })[
        "http.response.status_code"
      ] === 499
}

const scoreTrace = async (tracePath: string): Promise<TraceScore> => {
  const text = await readFile(tracePath, "utf8").catch(() => "")
  const lines = text.split(/\r?\n/u).filter(Boolean)
  let errorSpans = 0
  let clientClosedSpans = 0
  let agentSilentErrors = 0
  let unknownChannelErrors = 0
  let toolsCallSpans = 0
  let permissionRequestSpans = 0
  let sessionAgentOutputSpans = 0

  for (const line of lines) {
    const parsed = parseTraceLine(line)
    const serialized = textOf(parsed)
    if (isClientClosedSpan(parsed)) {
      clientClosedSpans += 1
    } else if (
      serialized.includes("\"status\":{\"code\":2") ||
      serialized.includes("\"level\":\"ERROR\"")
    ) {
      errorSpans += 1
    }
    if (
      serialized.includes("\"reason\":\"agent_silent\"") ||
      serialized.includes("\"_tag\":\"AcpStdioEdgeTurnOutputError\"")
    ) {
      agentSilentErrors += 1
    }
    if (
      serialized.includes("UnknownChannelTarget") ||
      serialized.includes("\"reason\":\"unknown-channel\"")
    ) {
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
    clientClosedSpans,
    agentSilentErrors,
    unknownChannelErrors,
    toolsCallSpans,
    permissionRequestSpans,
    sessionAgentOutputSpans,
  }
}

const scoreBoard = async (armDir: string): Promise<BoardScore> => {
  const rows = await readJson<ReadonlyArray<CoordinationBoardRow>>(
    path.join(armDir, "board-rows.json"),
  ).catch((): ReadonlyArray<CoordinationBoardRow> => [])
  const byChannel = rows.reduce<Record<string, number>>((counts, row) => {
    counts[row.channel] = (counts[row.channel] ?? 0) + 1
    return counts
  }, {})
  return {
    rows: rows.length,
    byChannel,
  }
}

const scoreArms = async (
  options: {
    readonly runDir: string
    readonly scenarioId?: string
    readonly armsDir: string
  },
): Promise<ReadonlyArray<ArmScore>> => {
  const arms = await readdir(options.armsDir).catch(() => [])
  const scores: Array<ArmScore> = []
  for (const arm of arms) {
    const armDir = path.join(options.armsDir, arm)
    const summary = await readJson<ArmSummary>(path.join(armDir, "summary.json"))
      .catch(() => undefined)
    const trace = await scoreTrace(path.join(armDir, "trace.jsonl"))
    const board = await scoreBoard(armDir)
    const score: ArmScore = {
      ...(options.scenarioId === undefined ? {} : { scenarioId: options.scenarioId }),
      arm,
      ...(summary === undefined ? {} : { summary }),
      trace,
      board,
    }
    scores.push(score)
    await writeJson(path.join(armDir, "score.json"), score)
  }
  return scores
}

export const scoreRun = async (runDir: string): Promise<ReadonlyArray<ArmScore>> => {
  const scenariosDir = path.join(runDir, "scenarios")
  const scenarioIds = await readdir(scenariosDir).catch(() => [])
  const scores = scenarioIds.length === 0
    ? await scoreArms({
      runDir,
      armsDir: path.join(runDir, "arms"),
    })
    : (
      await Promise.all(scenarioIds.map(scenarioId =>
        scoreArms({
          runDir,
          scenarioId,
          armsDir: path.join(scenariosDir, scenarioId, "arms"),
        })
      ))
    ).flat()

  await writeJson(path.join(runDir, "scores.json"), {
    "agent-coordination-patterns-experiment.ARTIFACTS.2": true,
    "agent-coordination-patterns-experiment.ARTIFACTS.4": true,
    scores,
  })
  return scores
}

export const writeScoreMarkdown = async (
  runDir: string,
  scores: ReadonlyArray<ArmScore>,
): Promise<void> => {
  const rows = scores.map(score =>
    // agent-coordination-patterns-experiment.ARTIFACTS.5
    `| ${score.scenarioId ?? "ad-hoc"} | ${score.arm} | ${score.summary?.status ?? "unknown"} | ${score.summary?.durationMs ?? 0} | ${score.summary?.sessionCount ?? 0} | ${score.summary?.outputCount ?? 0} | ${score.board?.rows ?? 0} | ${score.trace?.spans ?? 0} | ${score.trace?.errorSpans ?? 0} | ${score.trace?.clientClosedSpans ?? 0} | ${score.trace?.toolsCallSpans ?? 0} | ${score.trace?.agentSilentErrors ?? 0} | ${score.trace?.unknownChannelErrors ?? 0} |`,
  )
  const boardRows = scores.map(score =>
    `| ${score.scenarioId ?? "ad-hoc"} | ${score.arm} | ${Object.entries(score.board?.byChannel ?? {}).map(([channel, count]) => `${channel}:${count}`).join(", ") || "none"} |`,
  )
  await writeFile(
    path.join(runDir, "SCORE.md"),
    [
      "# Agent Coordination Pattern Scores",
      "",
      "| Scenario | Arm | Status | Duration ms | Sessions | Outputs | Board rows | Spans | Errors | Client closed | Tool Calls | agent_silent | unknown-channel |",
      "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...rows,
      "",
      "## Board Rows By Channel",
      "",
      "| Scenario | Arm | Channels |",
      "| --- | --- | --- |",
      ...boardRows,
      "",
    ].join("\n"),
    "utf8",
  )
}
