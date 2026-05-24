import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { boardChannelStatus } from "./board.ts"
import { writeJson } from "./files.ts"
import { promptForArm } from "./prompts.ts"
import type { ArmCommandArtifact, ArmSummary, ExperimentArm, RunOptions } from "./types.ts"

const repoRoot = process.cwd()

const runProcess = (
  command: ReadonlyArray<string>,
  options: {
    readonly cwd: string
    readonly stdoutPath: string
    readonly stderrPath: string
    readonly timeoutMs: number
  },
): Promise<{ readonly exitCode?: number; readonly signal?: string }> =>
  new Promise((resolve) => {
    const child = spawn(command[0] ?? "", command.slice(1), {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout: Array<Buffer> = []
    const stderr: Array<Buffer> = []
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
    }, options.timeoutMs)
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)))
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)))
    child.on("close", async (code, signal) => {
      clearTimeout(timer)
      await writeFile(options.stdoutPath, Buffer.concat(stdout))
      await writeFile(options.stderrPath, Buffer.concat(stderr))
      resolve({
        ...(code === null ? {} : { exitCode: code }),
        ...(signal === null ? {} : { signal }),
      })
    })
    child.on("error", async (error) => {
      clearTimeout(timer)
      await writeFile(options.stdoutPath, Buffer.concat(stdout))
      await writeFile(options.stderrPath, String(error), "utf8")
      resolve({ exitCode: 1 })
    })
  })

const shQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`

const shellCommandForArm = (
  arm: ExperimentArm,
  options: RunOptions,
  promptPath: string,
  tracePath: string,
): ReadonlyArray<string> => {
  const firegridArgs = [
    "pnpm",
    "firegrid",
    "--",
    "run",
    "--agent",
    options.runtime.agent,
    "--agent-protocol",
    options.runtime.agentProtocol,
    "--cwd",
    repoRoot,
    "--otel-file",
    tracePath,
    ...options.runtime.secretEnv.flatMap(name => ["--secret-env", name]),
    "--prompt",
  ].map(shQuote)
  const agentArgs = options.runtime.command.map(shQuote)
  return [
    "bash",
    "-lc",
    [
      ...firegridArgs,
      `"$(cat ${shQuote(promptPath)})"`,
      "--",
      ...agentArgs,
    ].join(" "),
  ]
}

export const runArm = async (
  arm: ExperimentArm,
  options: RunOptions,
): Promise<ArmSummary> => {
  const armDir = path.join(options.runDir, "arms", arm)
  await mkdir(armDir, { recursive: true })
  const startedAt = new Date().toISOString()
  const promptPath = path.join(armDir, "prompt.md")
  const tracePath = path.join(armDir, "trace.jsonl")
  const stdoutPath = path.join(armDir, "stdout.log")
  const stderrPath = path.join(armDir, "stderr.log")
  const summaryPath = path.join(armDir, "summary.json")
  const task = await import("./files.ts").then(m => m.readText(options.taskPath))
  await writeFile(promptPath, promptForArm(arm, task), "utf8")

  if (arm === "choreography") {
    const summary: ArmSummary = {
      arm,
      status: "blocked",
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      reason: boardChannelStatus.reason,
    }
    await writeJson(summaryPath, summary)
    await writeJson(path.join(armDir, "board-channel-status.json"), boardChannelStatus)
    return summary
  }

  const command = shellCommandForArm(arm, options, promptPath, tracePath)
  const commandArtifact: ArmCommandArtifact = {
    arm,
    command,
    cwd: repoRoot,
    tracePath,
    promptPath,
    startedAt,
  }
  await writeJson(path.join(armDir, "command.json"), commandArtifact)
  const startedMs = Date.now()
  const result = await runProcess(command, {
    cwd: repoRoot,
    stdoutPath,
    stderrPath,
    timeoutMs: options.timeoutMs,
  })
  const finishedAt = new Date().toISOString()
  const summary: ArmSummary = {
    arm,
    status: result.exitCode === 0 ? "completed" : "failed",
    startedAt,
    finishedAt,
    durationMs: Date.now() - startedMs,
    ...result,
  }
  await writeJson(summaryPath, summary)
  return summary
}

export const runExperiment = async (options: RunOptions): Promise<void> => {
  const summaries = []
  for (const arm of options.arms) {
    summaries.push(await runArm(arm, options))
  }
  await writeJson(path.join(options.runDir, "run-summary.json"), {
    "agent-coordination-patterns-experiment.ARTIFACTS.1": true,
    runId: options.runId,
    taskPath: options.taskPath,
    arms: summaries,
  })
}
