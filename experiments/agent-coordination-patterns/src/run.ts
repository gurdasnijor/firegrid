import { DurableStreamTestServer } from "@durable-streams/server"
import {
  Firegrid,
  FiregridConfig,
  FiregridStandaloneLive,
  local,
  type FiregridSessionHandle,
  type RuntimeAgentOutputObservation,
} from "@firegrid/client-sdk/firegrid"
import { envBinding } from "@firegrid/protocol/launch"
import { FiregridLocalHostLive } from "@firegrid/runtime/composition/host-live"
import {
  ensurePathInput,
  FiregridMcpServerLayer,
} from "@firegrid/runtime/producers/codecs/mcp"
import {
  FiregridEnvBindingsFromEnv,
  FiregridLocalProcessFromEnv,
} from "@firegrid/runtime/producers/sandbox/local-process-from-env"
import { FiregridOtelLive } from "@firegrid/observability/node"
import { Clock, Duration, Effect, Fiber, Layer, Scope } from "effect"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { makeCoordinationBoardHost, type CoordinationBoardHost } from "./board.ts"
import { readText, writeJson } from "./files.ts"
import { promptForArm } from "./prompts.ts"
import type {
  ArmCommandArtifact,
  ArmSessionArtifact,
  ArmSummary,
  ExperimentArm,
  ParticipantRuntime,
  RunOptions,
} from "./types.ts"

const repoRoot = process.cwd()

const sanitizeNamespaceSegment = (value: string): string =>
  value.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/-+/g, "-")

const runtimeIntent = (runtime: ParticipantRuntime) =>
  local.jsonl({
    argv: [...runtime.command],
    agent: runtime.agent,
    agentProtocol: runtime.agentProtocol,
    cwd: repoRoot,
    envBindings: runtime.secretEnv.map(name => envBinding(name, name)),
    runtimeContextMcp: { enabled: true },
  })

const clientLayer = (
  durableStreamsBaseUrl: string,
  namespace: string,
) =>
  FiregridStandaloneLive.pipe(
    Layer.provide(
      Layer.succeed(FiregridConfig, {
        durableStreamsBaseUrl,
        namespace,
      }),
    ),
  )

const hostLayer = (
  options: {
    readonly durableStreamsBaseUrl: string
    readonly namespace: string
    readonly runtime: ParticipantRuntime
    readonly board: CoordinationBoardHost
  },
) =>
  Layer.discard(
    FiregridMcpServerLayer({
      host: "127.0.0.1",
      port: 0,
      path: ensurePathInput("/mcp"),
    }),
  ).pipe(Layer.provideMerge(FiregridLocalHostLive({
    durableStreamsBaseUrl: options.durableStreamsBaseUrl,
    namespace: options.namespace,
    input: true,
    mcpChannels: options.board.registrations,
  }))).pipe(
    Layer.provide(FiregridLocalProcessFromEnv(globalThis.process.env)),
    Layer.provide(FiregridEnvBindingsFromEnv({
      processEnv: globalThis.process.env,
      allow: options.runtime.secretEnv.map(name => [name, name] as const),
    })),
  )

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

const outputTag = (output: RuntimeAgentOutputObservation): string => {
  const tagged = output as RuntimeAgentOutputObservation & {
    readonly _tag?: string
    readonly event?: { readonly _tag?: string }
  }
  return tagged.event?._tag ?? tagged._tag ?? "Unknown"
}

const outputText = (output: RuntimeAgentOutputObservation): string => {
  const event = output.event
  return event._tag === "TextChunk" ? event.part.delta : ""
}

const collectSessionOutputs = (
  session: FiregridSessionHandle,
  timeoutMs: number,
): Effect.Effect<ReadonlyArray<RuntimeAgentOutputObservation>, unknown, Firegrid> =>
  Effect.gen(function*() {
    const outputs: Array<RuntimeAgentOutputObservation> = []
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs
    let afterSequence: number | undefined
    while ((yield* Clock.currentTimeMillis) < deadline) {
      const now = yield* Clock.currentTimeMillis
      const remaining = Math.max(1, Math.min(10_000, deadline - now))
      const next = yield* session.wait.forAgentOutput({
        ...(afterSequence === undefined ? {} : { afterSequence }),
        timeoutMs: remaining,
      })
      if (!next.matched) break
      outputs.push(next.output)
      afterSequence = next.output.sequence
      const tag = outputTag(next.output)
      if (tag === "TurnComplete" || tag === "Terminated") break
    }
    return outputs
  })

const createParticipant = (
  input: {
    readonly arm: ExperimentArm
    readonly role: string
    readonly prompt: string
    readonly options: RunOptions
  },
): Effect.Effect<ArmSessionArtifact, unknown, Firegrid | Scope.Scope> =>
  Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: {
        source: "agent-coordination-patterns",
        id: `${input.options.runId}:${input.arm}:${input.role}`,
      },
      runtime: runtimeIntent(input.options.runtime),
      createdBy: "agent-coordination-patterns-experiment",
    })
    yield* session.permissions.autoApprove("allow", {
      timeoutMs: Math.min(input.options.timeoutMs, 30_000),
    })
    yield* session.prompt({
      payload: input.prompt,
      idempotencyKey:
        `${input.options.runId}:${input.arm}:${input.role}:initial-prompt`,
    })
    yield* session.start()
    const outputs = yield* collectSessionOutputs(session, input.options.timeoutMs)
    return {
      role: input.role,
      sessionId: session.sessionId,
      contextId: session.contextId,
      outputCount: outputs.length,
      outputs,
    }
  })

const runParticipantPlan = (
  arm: ExperimentArm,
  options: RunOptions,
  task: string,
  board: CoordinationBoardHost,
): Effect.Effect<ReadonlyArray<ArmSessionArtifact>, unknown, Firegrid | Scope.Scope> =>
  Effect.gen(function*() {
    switch (arm) {
      case "single":
        return [
          yield* createParticipant({
            arm,
            role: "solo",
            prompt: promptForArm(arm, task),
            options,
          }),
        ]
      case "central":
        return [
          yield* createParticipant({
            arm,
            role: "manager",
            prompt: promptForArm(arm, task),
            options,
          }),
        ]
      case "choreography": {
        yield* board.append("coordination.work", {
          kind: "task",
          workId: `${options.runId}:primary-task`,
          title: "Shared experiment task",
          body: task,
          status: "open",
        })
        const roles = ["planner", "builder", "reviewer"] as const
        const results: Array<ArmSessionArtifact> = []
        for (const role of roles) {
          results.push(yield* createParticipant({
            arm,
            role,
            prompt: promptForArm(arm, task),
            options,
          }))
        }
        return results
      }
    }
  })

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
        const namespace = `agent-coordination.${sanitizeNamespaceSegment(options.runId)}.${arm}`
        const board = makeCoordinationBoardHost({
          baseUrl: durableStreamsBaseUrl,
          namespace,
          runId: options.runId,
          arm,
        })
        const commandArtifact: ArmCommandArtifact = {
          arm,
          runner: "client-host",
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
          hostLayer({
            durableStreamsBaseUrl,
            namespace,
            runtime: options.runtime,
            board,
          }),
        ).pipe(Effect.forkScoped)

        const run = runParticipantPlan(arm, options, task, board).pipe(
          Effect.provide(clientLayer(durableStreamsBaseUrl, namespace)),
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
            status: "failed" as const,
            startedAt: commandArtifact.startedAt,
            finishedAt: new Date().toISOString(),
            durationMs: 0,
            reason: String(either.left),
          } satisfies ArmSummary
        }

        const sessions = either.right
        const text = sessions.flatMap(session =>
          session.outputs.map(outputText).filter(part => part.length > 0)
        ).join("")
        yield* Effect.promise(() =>
          Promise.all([
            writeFile(paths.stdoutPath, text, "utf8"),
            writeFile(paths.stderrPath, "", "utf8"),
            writeJson(path.join(path.dirname(paths.promptPath), "sessions.json"), sessions),
            writeJson(
              path.join(path.dirname(paths.promptPath), "board-rows.json"),
              board.recordedRows(),
            ),
          ])
        )
        return {
          arm,
          status: "completed",
          startedAt: commandArtifact.startedAt,
          finishedAt: new Date().toISOString(),
          durationMs: 0,
          sessionCount: sessions.length,
          outputCount: sessions.reduce((sum, session) => sum + session.outputCount, 0),
        } satisfies ArmSummary
      }).pipe(
        Effect.provide(
          FiregridOtelLive({
            resource: {
              serviceName: "agent-coordination-patterns-experiment",
              attributes: {
                "firegrid.experiment": "agent-coordination-patterns",
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
  const armDir = path.join(options.runDir, "arms", arm)
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
  await writeJson(path.join(options.runDir, "run-summary.json"), {
    "agent-coordination-patterns-experiment.ARTIFACTS.1": true,
    "agent-coordination-patterns-experiment.EXECUTION.1": true,
    "agent-coordination-patterns-experiment.EXECUTION.3": true,
    runId: options.runId,
    taskPath: options.taskPath,
    arms: summaries,
  })
}
