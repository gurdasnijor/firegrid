import { DurableStreamTestServer } from "@durable-streams/server"
import { FiregridOtelLive } from "@firegrid/observability/node"
import { Duration, Effect, Fiber, Layer, Scope } from "effect"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { makeCoordinationBoardHost } from "./app/coordination-board.ts"
import {
  makeAgentCoordinationFiregridClient,
  runAgentCoordinationClient,
} from "./client.ts"
import { ensureRunDir, makeRunId, readJson, readText, writeJson } from "./files.ts"
import { makeAgentCoordinationFiregridHost } from "./host.ts"
import { promptForArm } from "./prompts.ts"
import { parseScenarioIds, resolveScenarios } from "./scenarios.ts"
import type {
  ArmCommandArtifact,
  ArmSummary,
  ExperimentArm,
  ExperimentRunPlan,
  ParticipantRuntime,
  RunOptions,
} from "./types.ts"

export const defaultParticipantRuntime: ParticipantRuntime = {
  agent: "claude-acp",
  agentProtocol: "acp",
  command: ["npx", "-y", "@agentclientprotocol/claude-agent-acp@0.36.1"],
  secretEnv: ["ANTHROPIC_API_KEY"],
}

export const defaultExperimentArms = ["single", "central"] as const
export const defaultExperimentTimeoutMs = 300_000

export const defaultExperimentRunPlan: ExperimentRunPlan = {
  arms: defaultExperimentArms,
  runtime: defaultParticipantRuntime,
  timeoutMs: defaultExperimentTimeoutMs,
}

const sanitizeNamespaceSegment = (value: string): string =>
  value.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/-+/g, "-")

const withDurableStreams = <A, E, R>(
  body: (
    durableStreamsBaseUrl: string,
  ) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
      const baseUrl = await server.start()
      return { server, baseUrl }
    }),
    ({ server }) => Effect.promise(() => server.stop()),
  ).pipe(
    Effect.flatMap(({ baseUrl }) => body(baseUrl)),
  )

const runArmEffect = (
  arm: ExperimentArm,
  options: RunOptions,
  paths: {
    readonly promptPath: string
    readonly tracePath: string
    readonly stdoutPath: string
    readonly stderrPath: string
  },
  task: string,
): Effect.Effect<ArmSummary, never, never> =>
  Effect.scoped(
    withDurableStreams((durableStreamsBaseUrl) =>
      Effect.gen(function*() {
        const namespace =
          `agent-coordination.${sanitizeNamespaceSegment(options.runId)}.${sanitizeNamespaceSegment(options.scenario.id)}.${arm}`
        const board = makeCoordinationBoardHost({
          baseUrl: durableStreamsBaseUrl,
          namespace,
          runId: options.runId,
          arm,
        })
        const commandArtifact: ArmCommandArtifact = {
          scenarioId: options.scenario.id,
          arm,
          runner: "firegrid-conductor",
          durableStreamsBaseUrl,
          namespace,
          tracePath: paths.tracePath,
          promptPath: paths.promptPath,
          startedAt: new Date().toISOString(),
        }
        yield* Effect.promise(() =>
          writeJson(
            path.join(path.dirname(paths.promptPath), "command.json"),
            commandArtifact,
          )
        )
        const hostFiber = yield* Layer.launch(
          makeAgentCoordinationFiregridHost({
            durableStreamsBaseUrl,
            namespace,
            runtime: options.runtime,
            board,
          }),
        ).pipe(Effect.forkScoped)

        const run = runAgentCoordinationClient({ arm, options, task }).pipe(
          Effect.provide(
            makeAgentCoordinationFiregridClient({
              durableStreamsBaseUrl,
              namespace,
              board,
            }),
          ),
        )
        const either = yield* run.pipe(
          Effect.timeoutFail({
            duration: Duration.millis(options.timeoutMs),
            onTimeout: () => new Error(`arm ${arm} timed out`),
          }),
          Effect.either,
        )
        yield* Fiber.interrupt(hostFiber)

        if (either._tag === "Left") {
          yield* Effect.promise(() =>
            writeFile(paths.stderrPath, String(either.left), "utf8")
          )
          return {
            arm,
            scenarioId: options.scenario.id,
            status: "failed" as const,
            startedAt: commandArtifact.startedAt,
            finishedAt: new Date().toISOString(),
            durationMs: 0,
            reason: String(either.left),
          } satisfies ArmSummary
        }

        const { sessions, finalArtifact, outputText } = either.right
        yield* Effect.promise(() =>
          Promise.all([
            writeFile(paths.stdoutPath, outputText, "utf8"),
            writeFile(paths.stderrPath, "", "utf8"),
            writeJson(path.join(path.dirname(paths.promptPath), "sessions.json"), sessions),
            writeJson(
              path.join(path.dirname(paths.promptPath), "board-rows.json"),
              board.recordedRows(),
            ),
            writeJson(
              path.join(path.dirname(paths.promptPath), "final-artifact.json"),
              finalArtifact ?? null,
            ),
          ])
        )
        if (finalArtifact === undefined) {
          return {
            arm,
            scenarioId: options.scenario.id,
            status: "failed",
            startedAt: commandArtifact.startedAt,
            finishedAt: new Date().toISOString(),
            durationMs: 0,
            reason: "missing coordination.final artifact",
            sessionCount: sessions.length,
            outputCount: sessions.reduce((sum, session) => sum + session.outputCount, 0),
          } satisfies ArmSummary
        }
        return {
          arm,
          scenarioId: options.scenario.id,
          status: "completed",
          startedAt: commandArtifact.startedAt,
          finishedAt: new Date().toISOString(),
          durationMs: 0,
          sessionCount: sessions.length,
          outputCount: sessions.reduce((sum, session) => sum + session.outputCount, 0),
          finalArtifact,
        } satisfies ArmSummary
      }).pipe(
        Effect.provide(
          FiregridOtelLive({
            resource: {
              serviceName: "agent-coordination-patterns-experiment",
              attributes: {
                "firegrid.experiment": "agent-coordination-patterns",
                "firegrid.experiment.scenario": options.scenario.id,
                "firegrid.experiment.arm": arm,
                "firegrid.run.id": options.runId,
              },
            },
            destination: { _tag: "file", filePath: paths.tracePath },
          }),
        ),
      )
    ),
  ).pipe(
    Effect.catchAll((cause) =>
      Effect.succeed({
        arm,
        scenarioId: options.scenario.id,
        status: "failed" as const,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        reason: String(cause),
      }),
    ),
  )

const runArm = async (
  arm: ExperimentArm,
  options: RunOptions,
): Promise<ArmSummary> => {
  const armDir = path.join(options.scenarioDir, "arms", arm)
  await mkdir(armDir, { recursive: true })
  const startedMs = Date.now()
  const promptPath = path.join(armDir, "prompt.md")
  const tracePath = path.join(armDir, "trace.jsonl")
  const stdoutPath = path.join(armDir, "stdout.log")
  const stderrPath = path.join(armDir, "stderr.log")
  const summaryPath = path.join(armDir, "summary.json")
  const task = await readText(options.taskPath)
  await writeFile(promptPath, promptForArm(arm, task), "utf8")

  const summary = await Effect.runPromise(
    runArmEffect(
      arm,
      options,
      { promptPath, tracePath, stdoutPath, stderrPath },
      task,
    ),
  )
  const timedSummary = {
    ...summary,
    durationMs: Date.now() - startedMs,
  }
  await writeJson(summaryPath, timedSummary)
  return timedSummary
}

export const runExperiment = async (options: RunOptions): Promise<void> => {
  const summaries = []
  for (const arm of options.arms) {
    summaries.push(await runArm(arm, options))
  }
  await writeJson(path.join(options.scenarioDir, "scenario-summary.json"), {
    "agent-coordination-patterns-experiment.ARTIFACTS.1": true,
    "agent-coordination-patterns-experiment.EXECUTION.1": true,
    "agent-coordination-patterns-experiment.EXECUTION.3": true,
    runId: options.runId,
    scenario: options.scenario,
    taskPath: options.taskPath,
    arms: summaries,
  })
}

export const runExperimentMatrix = async (
  plan: ExperimentRunPlan = defaultExperimentRunPlan,
): Promise<string> => {
  // agent-coordination-patterns-experiment.EXECUTION.8
  const runId = plan.runId ?? makeRunId()
  const runDir = await ensureRunDir(runId)
  const taskOverridePath = plan.taskOverridePath
  const scenarios = resolveScenarios(
    plan.scenarioIds === undefined
      ? parseScenarioIds(undefined)
      : plan.scenarioIds,
  )
  const arms = plan.arms ?? defaultExperimentArms
  const runtime = plan.runtime ?? defaultParticipantRuntime
  const timeoutMs = plan.timeoutMs ?? defaultExperimentTimeoutMs
  await writeJson(path.join(runDir, "manifest.json"), {
    "agent-coordination-patterns-experiment.SCENARIOS.2": true,
    "agent-coordination-patterns-experiment.EXECUTION.1": true,
    "agent-coordination-patterns-experiment.EXECUTION.8": true,
    runId,
    scenarios: scenarios.map(scenario => ({
      id: scenario.id,
      name: scenario.name,
      axis: scenario.axis,
      hypothesis: scenario.hypothesis,
      expectedDivergence: scenario.expectedDivergence,
    })),
    arms,
    runtime: {
      agent: runtime.agent,
      agentProtocol: runtime.agentProtocol,
      command: runtime.command,
      secretEnv: runtime.secretEnv,
    },
    createdAt: new Date().toISOString(),
  })
  const summaries = []
  for (const scenario of scenarios) {
    const scenarioDir = path.join(runDir, "scenarios", scenario.id)
    await mkdir(scenarioDir, { recursive: true })
    const taskPath = path.join(scenarioDir, "task.md")
    const taskPacket = taskOverridePath === undefined
      ? scenario.taskPacket
      : await readText(taskOverridePath)
    await writeFile(taskPath, taskPacket, "utf8")
    await writeJson(path.join(scenarioDir, "scenario.json"), {
      "agent-coordination-patterns-experiment.SCENARIOS.3": true,
      ...scenario,
      taskPath,
    })
    await runExperiment({
      runId,
      runDir,
      scenario,
      scenarioDir,
      taskPath,
      arms,
      runtime,
      timeoutMs,
    })
    summaries.push(await readJson(path.join(scenarioDir, "scenario-summary.json")))
  }
  await writeJson(path.join(runDir, "run-summary.json"), {
    "agent-coordination-patterns-experiment.ARTIFACTS.4": true,
    runId,
    scenarios: summaries,
  })
  return runDir
}
