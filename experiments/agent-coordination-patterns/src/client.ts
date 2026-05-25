import {
  Firegrid,
  FiregridConfig,
  FiregridStandaloneLive,
  local,
  type FiregridSessionHandle,
  type RuntimeAgentOutputObservation,
} from "@firegrid/client-sdk/firegrid"
import { envBinding } from "@firegrid/protocol/launch"
import { Duration, Effect, Layer, Scope } from "effect"
import type {
  CoordinationBoardHost,
  CoordinationBoardPayload,
  CoordinationBoardRow,
} from "./app/coordination-board.ts"
import { promptForArm } from "./prompts.ts"
import type {
  ArmSessionArtifact,
  ExperimentArm,
  InboundSignal,
  ParticipantRuntime,
  RunOptions,
} from "./types.ts"

interface StartedConductorSession {
  readonly role: "conductor"
  readonly sessionId: string
  readonly contextId: string
  readonly session: FiregridSessionHandle
}

interface AgentCoordinationClientResult {
  readonly sessions: ReadonlyArray<ArmSessionArtifact>
  readonly finalArtifact?: CoordinationBoardRow
  readonly outputText: string
}

const repoRoot = process.cwd()

export const makeAgentCoordinationFiregridClient = (
  options: {
    readonly durableStreamsBaseUrl: string
    readonly namespace: string
    readonly board: CoordinationBoardHost
  },
) =>
  FiregridStandaloneLive.pipe(
    Layer.provide(
      Layer.succeed(FiregridConfig, {
        durableStreamsBaseUrl: options.durableStreamsBaseUrl,
        namespace: options.namespace,
        channels: options.board.registrations,
      }),
    ),
  )

const runtimeIntent = (runtime: ParticipantRuntime) =>
  local.jsonl({
    argv: [...runtime.command],
    agent: runtime.agent,
    agentProtocol: runtime.agentProtocol,
    cwd: repoRoot,
    envBindings: runtime.secretEnv.map(name => envBinding(name, name)),
    runtimeContextMcp: { enabled: true },
  })

const outputText = (output: RuntimeAgentOutputObservation): string => {
  const event = output.event
  return event._tag === "TextChunk" ? event.part.delta : ""
}

const conductorPromptForArm = (
  arm: ExperimentArm,
  options: RunOptions,
  task: string,
): string => {
  const base = promptForArm(arm, task)
  const common = [
    "You are the Firegrid experiment conductor for this arm.",
    "Run the experiment from inside Firegrid using the normal Firegrid tools.",
    "The bootstrap process will only observe artifacts; it will not create worker sessions or coordinate the work for you.",
    `Run id: ${options.runId}`,
    `Scenario id: ${options.scenario.id}`,
    `Arm: ${arm}`,
    `Child agentKind to use when you create child sessions: ${options.runtime.agent}`,
    "",
  ]

  switch (arm) {
    case "single":
      return [
        ...common,
        "For the single-agent arm, you are the only participant.",
        "Do not create child sessions. Complete the task yourself and publish coordination.final.",
        "",
        base,
      ].join("\n")
    case "central":
      return [
        ...common,
        "For the central-orchestrator arm, you are the manager participant.",
        "Use session_new to create at least two child sessions with distinct assignments.",
        "Use wait_for on session.agent_output to observe at least one child reply before publishing coordination.final.",
        "Important: session.agent_output returns one event at a time. Start with match:{sessionId:<child sessionId>, afterSequence:-1}; if the event is Ready or Status, set afterSequence to the returned event.sequence and call wait_for again until you see TextChunk or TurnComplete.",
        "Do not use wait_for_any for session.agent_output.",
        "",
        base,
      ].join("\n")
    case "choreography":
      return [
        ...common,
        "For the choreography arm, bootstrap peer work without becoming a manager.",
        "Use session_new to create three peer sessions with distinct names: planner, builder, reviewer.",
        "Give each peer the choreography instructions below and tell them to coordinate through the board channels, not through you.",
        "After creating peers, observe coordination.final and session.agent_output as needed. Do not privately assign hidden work after the initial peer prompts.",
        "",
        base,
      ].join("\n")
  }
}

const createConductor = (
  input: {
    readonly arm: ExperimentArm
    readonly task: string
    readonly options: RunOptions
  },
): Effect.Effect<StartedConductorSession, unknown, Firegrid | Scope.Scope> =>
  Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: {
        source: "agent-coordination-patterns",
        id:
          `${input.options.runId}:${input.options.scenario.id}:${input.arm}:conductor`,
      },
      runtime: runtimeIntent(input.options.runtime),
      createdBy: "agent-coordination-patterns-experiment",
    })
    yield* session.prompt({
      payload: conductorPromptForArm(input.arm, input.options, input.task),
      idempotencyKey:
        `${input.options.runId}:${input.options.scenario.id}:${input.arm}:conductor-prompt`,
    })
    // agent-coordination-patterns-experiment.EXECUTION.9
    yield* session.start()
    return {
      role: "conductor",
      sessionId: session.sessionId,
      contextId: session.contextId,
      session,
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

const snapshotConductorArtifact = (
  session: StartedConductorSession,
): Effect.Effect<ArmSessionArtifact, unknown, never> =>
  Effect.gen(function*() {
    const snapshot = yield* session.session.snapshot()
    const outputs = snapshot.agentOutputs
    return {
      role: session.role,
      sessionId: session.sessionId,
      contextId: session.contextId,
      outputCount: outputs.length,
      outputs,
    }
  })

export const runAgentCoordinationClient = (
  input: {
    readonly arm: ExperimentArm
    readonly options: RunOptions
    readonly task: string
  },
): Effect.Effect<AgentCoordinationClientResult, unknown, Firegrid | Scope.Scope> =>
  Effect.gen(function*() {
    yield* Effect.forkScoped(injectInboundSignals(input.options))
    const conductor = yield* createConductor(input)
    const finalArtifact = yield* waitForFinalArtifact(input.arm, input.options)
    yield* Effect.sleep(Duration.millis(500))
    const sessions = [yield* snapshotConductorArtifact(conductor)]
    const text = sessions.flatMap(session =>
      session.outputs.map(outputText).filter(part => part.length > 0)
    ).join("")
    return {
      sessions,
      ...(finalArtifact === undefined ? {} : { finalArtifact }),
      outputText: text,
    }
  })
