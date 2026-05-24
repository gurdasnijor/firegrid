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
import { Clock, Duration, Effect, Fiber, Layer, Ref, Scope } from "effect"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  makeCoordinationBoardHost,
  type CoordinationBoardHost,
  type CoordinationBoardPayload,
  type CoordinationBoardRow,
} from "./app/coordination-board.ts"
import { readText, writeJson } from "./files.ts"
import { promptForArm } from "./prompts.ts"
import type {
  ArmCommandArtifact,
  ArmSessionArtifact,
  ArmSummary,
  ExperimentArm,
  InboundSignal,
  ParticipantRuntime,
  RunOptions,
} from "./types.ts"

interface StartedArmSession {
  readonly role: string
  readonly sessionId: string
  readonly contextId: string
  readonly outputs: Ref.Ref<ReadonlyArray<RuntimeAgentOutputObservation>>
  readonly outputFiber: Fiber.RuntimeFiber<void, unknown>
  readonly startFiber: Fiber.RuntimeFiber<unknown, unknown>
}

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
  board: CoordinationBoardHost,
) =>
  FiregridStandaloneLive.pipe(
    Layer.provide(
      Layer.succeed(FiregridConfig, {
        durableStreamsBaseUrl,
        namespace,
        channels: board.registrations,
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
  outputs: Ref.Ref<ReadonlyArray<RuntimeAgentOutputObservation>>,
): Effect.Effect<void, unknown, Firegrid> =>
  Effect.gen(function*() {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs
    let afterSequence: number | undefined
    while ((yield* Clock.currentTimeMillis) < deadline) {
      const now = yield* Clock.currentTimeMillis
      const remaining = Math.max(1, Math.min(10_000, deadline - now))
      const next = yield* session.wait.forAgentOutput({
        ...(afterSequence === undefined ? {} : { afterSequence }),
        timeoutMs: remaining,
      })
      // agent-coordination-patterns-experiment.EXECUTION.6
      if (!next.matched) continue
      yield* Ref.update(outputs, current => [...current, next.output])
      afterSequence = next.output.sequence
      const tag = outputTag(next.output)
      if (tag === "TurnComplete" || tag === "Terminated") break
    }
  })

const createParticipant = (
  input: {
    readonly arm: ExperimentArm
    readonly role: string
    readonly prompt: string
    readonly options: RunOptions
  },
): Effect.Effect<StartedArmSession, unknown, Firegrid | Scope.Scope> =>
  Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: {
        source: "agent-coordination-patterns",
        id:
          `${input.options.runId}:${input.options.scenario.id}:${input.arm}:${input.role}`,
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
        `${input.options.runId}:${input.options.scenario.id}:${input.arm}:${input.role}:initial-prompt`,
    })
    // agent-coordination-patterns-experiment.EXECUTION.7
    const startFiber = yield* session.start().pipe(Effect.forkScoped)
    const outputs = yield* Ref.make<ReadonlyArray<RuntimeAgentOutputObservation>>([])
    const outputFiber = yield* collectSessionOutputs(
      session,
      input.options.timeoutMs,
      outputs,
    ).pipe(Effect.forkScoped)
    return {
      role: input.role,
      sessionId: session.sessionId,
      contextId: session.contextId,
      outputs,
      outputFiber,
      startFiber,
    }
  })

const runParticipantPlan = (
  arm: ExperimentArm,
  options: RunOptions,
  task: string,
): Effect.Effect<ReadonlyArray<StartedArmSession>, unknown, Firegrid | Scope.Scope> =>
  Effect.gen(function*() {
    yield* Effect.forkScoped(injectInboundSignals(options))
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
        const firegrid = yield* Firegrid
        yield* firegrid.channels.send("coordination.work", {
          kind: "task",
          workId: `${options.runId}:${options.scenario.id}:primary-task`,
          title: "Shared experiment task",
          body: task,
          status: "open",
        })
        const roles = ["planner", "builder", "reviewer"] as const
        return yield* Effect.all(
          roles.map(role =>
            createParticipant({
              arm,
              role,
              prompt: promptForArm(arm, task),
              options,
            })
          ),
          { concurrency: "unbounded" },
        )
      }
    }
  })

const injectInboundSignal = (
  options: RunOptions,
  signal: InboundSignal,
): Effect.Effect<void, unknown, Firegrid> =>
  // agent-coordination-patterns-experiment.SCENARIOS.4
  Effect.gen(function*() {
    const firegrid = yield* Firegrid
    yield* Effect.sleep(Duration.millis(signal.atMs))
    yield* firegrid.channels.send(
      signal.channel,
      {
        kind: signal.kind,
        title: signal.title,
        body: signal.body,
        status: signal.status ?? "open",
        ...(signal.workId === undefined ? {} : { workId: signal.workId }),
        payload: {
          scenarioId: options.scenario.id,
          atMs: signal.atMs,
        },
      } satisfies CoordinationBoardPayload,
    )
  }).pipe(Effect.asVoid)

const injectInboundSignals = (
  options: RunOptions,
): Effect.Effect<void, unknown, Firegrid> =>
  Effect.all(
    options.scenario.inboundSignals.map(signal =>
      injectInboundSignal(options, signal)
    ),
    { concurrency: "unbounded" },
  ).pipe(Effect.asVoid)

const waitForFinalArtifact = (
  arm: ExperimentArm,
  options: RunOptions,
): Effect.Effect<CoordinationBoardRow | undefined, unknown, Firegrid> =>
  Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const final = yield* firegrid.channels.waitFor("coordination.final", {
      match: {
        runId: options.runId,
        arm,
      },
      timeoutMs: options.timeoutMs,
    })
    return final.matched ? final.event as CoordinationBoardRow : undefined
  })

const snapshotSessionArtifact = (
  session: StartedArmSession,
): Effect.Effect<ArmSessionArtifact> =>
  Effect.gen(function*() {
    const outputs = yield* Ref.get(session.outputs)
    return {
      role: session.role,
      sessionId: session.sessionId,
      contextId: session.contextId,
      outputCount: outputs.length,
      outputs,
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

        const run = Effect.gen(function*() {
          const activeSessions = yield* runParticipantPlan(arm, options, task)
          const finalArtifact = yield* waitForFinalArtifact(arm, options)
          yield* Effect.sleep(Duration.millis(500))
          const sessions = yield* Effect.all(
            activeSessions.map(snapshotSessionArtifact),
          )
          yield* Effect.forEach(
            activeSessions,
            session => Fiber.interrupt(session.outputFiber),
            { discard: true },
          )
          yield* Effect.forEach(
            activeSessions,
            session => Fiber.interrupt(session.startFiber),
            { discard: true },
          )
          return { sessions, finalArtifact }
        }).pipe(
          Effect.provide(clientLayer(durableStreamsBaseUrl, namespace, board)),
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

        const { sessions, finalArtifact } = either.right
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
