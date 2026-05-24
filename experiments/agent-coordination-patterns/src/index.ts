#!/usr/bin/env tsx
import path from "node:path"
import { stat } from "node:fs/promises"
import { initRun } from "./init.ts"
import { ensureRunDir, experimentRoot, makeRunId, readText, resolveRunDir, writeJson } from "./files.ts"
import { compileFinding } from "./finding.ts"
import { runExperiment } from "./run.ts"
import { scoreRun, writeScoreMarkdown } from "./score.ts"
import type { ExperimentArm, ParticipantRuntime } from "./types.ts"

const usage = `Usage:
  pnpm exec tsx experiments/agent-coordination-patterns/src/index.ts init
  pnpm exec tsx experiments/agent-coordination-patterns/src/index.ts run [--arms single,central] [--task PATH]
  pnpm exec tsx experiments/agent-coordination-patterns/src/index.ts score --run-dir PATH
  pnpm exec tsx experiments/agent-coordination-patterns/src/index.ts finding --run-dir PATH
`

const argValue = (args: ReadonlyArray<string>, name: string): string | undefined => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

const parseArms = (value: string | undefined): ReadonlyArray<ExperimentArm> => {
  const raw = value ?? "single,central"
  return raw.split(",").map(part => part.trim()).filter(Boolean).map((part) => {
    if (part === "single" || part === "central" || part === "choreography") {
      return part
    }
    throw new Error(`Unknown arm ${JSON.stringify(part)}`)
  })
}

const runtimeFromArgs = (args: ReadonlyArray<string>): ParticipantRuntime => ({
  agent: argValue(args, "--agent") ?? "claude-acp",
  agentProtocol: (argValue(args, "--agent-protocol") ?? "acp") as "acp",
  command: (argValue(args, "--agent-command") ?? "npx -y @agentclientprotocol/claude-agent-acp@0.36.1")
    .split(/\s+/u)
    .filter(Boolean),
  secretEnv: (argValue(args, "--secret-env") ?? "ANTHROPIC_API_KEY")
    .split(",")
    .map(part => part.trim())
    .filter(Boolean),
})

const latestRunDir = path.join(experimentRoot, "latest")

const run = async (): Promise<void> => {
  const [, , command, ...args] = process.argv
  if (command === "init") {
    await initRun()
    return
  }
  if (command === "run") {
    const runId = argValue(args, "--run-id") ?? makeRunId()
    const runDir = await ensureRunDir(runId)
    const taskPath = argValue(args, "--task") ?? path.join(runDir, "task.md")
    await stat(taskPath).catch(async () => {
      const { defaultTaskPacket } = await import("./task.ts")
      await import("node:fs/promises").then(fs => fs.writeFile(taskPath, defaultTaskPacket, "utf8"))
    })
    await writeJson(path.join(runDir, "manifest.json"), {
      "agent-coordination-patterns-experiment.EXECUTION.1": true,
      runId,
      taskPath,
      arms: parseArms(argValue(args, "--arms")),
      createdAt: new Date().toISOString(),
    })
    await runExperiment({
      runId,
      runDir,
      taskPath,
      arms: parseArms(argValue(args, "--arms")),
      runtime: runtimeFromArgs(args),
      timeoutMs: Number(argValue(args, "--timeout-ms") ?? "300000"),
    })
    console.log(runDir)
    return
  }
  if (command === "score") {
    const runDir = await resolveRunDir(argValue(args, "--run-dir") ?? latestRunDir)
    const scores = await scoreRun(runDir)
    await writeScoreMarkdown(runDir, scores)
    console.log(path.join(runDir, "SCORE.md"))
    return
  }
  if (command === "finding") {
    const runDir = await resolveRunDir(argValue(args, "--run-dir") ?? latestRunDir)
    await compileFinding(runDir)
    console.log(path.join(runDir, "FINDING.md"))
    return
  }
  if (command === "show-task") {
    const taskPath = argValue(args, "--task") ?? path.join(latestRunDir, "task.md")
    console.log(await readText(taskPath))
    return
  }
  console.error(usage)
  process.exitCode = 1
}

run().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
