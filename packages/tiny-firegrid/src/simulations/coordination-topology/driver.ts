import {
  Firegrid,
  local,
  type FiregridSessionHandle,
} from "@firegrid/client-sdk/firegrid"
import { Config, Effect, Option } from "effect"
import { agenticPatternsExternalKey } from "../agentic-patterns-primitive-profile/profile.ts"
import {
  coordinationTopologyArtifactsTarget,
  coordinationTopologyClaimsTarget,
  coordinationTopologyItemCount,
  coordinationTopologyReportsTarget,
  coordinationTopologyScoresTarget,
  coordinationTopologyWorkerActionTarget,
  coordinationTopologyWorkerCount,
  type CoordinationTopologyArm,
} from "./host.ts"

type RunMode = "live-frontier" | "fixture-smoke"

interface ParticipantRun {
  readonly label: string
  readonly sessionId: string
  readonly contextId: string
  readonly completed: boolean
}

interface ArmRun {
  readonly arm: CoordinationTopologyArm
  readonly mode: RunMode
  readonly participants: ReadonlyArray<ParticipantRun>
}

interface CoordinationTopologyResult {
  readonly mode: RunMode
  readonly runId: string
  readonly arms: ReadonlyArray<ArmRun>
}

const liveFlagConfig = Config.string("FIREGRID_COORDINATION_EXPERIMENT_LIVE")
  .pipe(Config.withDefault("0"))
const anthropicKeyConfig = Config.string("ANTHROPIC_API_KEY").pipe(Config.option)

const claudeAcpArgv = [
  "npx",
  "-y",
  "@agentclientprotocol/claude-agent-acp@0.36.1",
] as const

const liveArms: ReadonlyArray<CoordinationTopologyArm> = [
  "single",
  "developer-authored-orchestration",
  "choreography",
]

const channels = {
  artifacts: coordinationTopologyArtifactsTarget,
  claims: coordinationTopologyClaimsTarget,
  reports: coordinationTopologyReportsTarget,
  scores: coordinationTopologyScoresTarget,
  workerAction: coordinationTopologyWorkerActionTarget,
} as const

const taskPacket = [
  "# Coordination Experiment Task Packet",
  "",
  "You are working in a software-factory bench run. The artifact you produce is",
  "a concise patch plan and review notes, not an edit to this repository.",
  "",
  "## Product task",
  "",
  "A small TypeScript service has a flaky retry/deduplication defect. External",
  "webhook events can arrive twice. A failed provider call should be retried",
  "with the same idempotency key, but once a run is terminally completed, later",
  "duplicate events must not call the provider again.",
  "",
  "Relevant fixture files:",
  "",
  "```ts",
  "// src/run-queue.ts",
  "type RunStatus = \"queued\" | \"in_progress\" | \"failed\" | \"completed\"",
  "type Run = { id: string; externalEventId: string; status: RunStatus; attempts: number }",
  "const runs = new Map<string, Run>()",
  "",
  "export function enqueueRun(externalEventId: string): Run {",
  "  const existing = runs.get(externalEventId)",
  "  if (existing) return existing",
  "  const run = { id: crypto.randomUUID(), externalEventId, status: \"queued\", attempts: 0 }",
  "  runs.set(externalEventId, run)",
  "  return run",
  "}",
  "",
  "export function claimNext(): Run | undefined {",
  "  const run = [...runs.values()].find(row => row.status !== \"completed\")",
  "  if (!run) return undefined",
  "  run.status = \"in_progress\"",
  "  run.attempts += 1",
  "  return run",
  "}",
  "```",
  "",
  "```ts",
  "// src/provider.ts",
  "export async function callProvider(runId: string, payload: unknown): Promise<void> {",
  "  await fetch(\"https://provider.example/jobs\", {",
  "    method: \"POST\",",
  "    headers: { \"Idempotency-Key\": crypto.randomUUID() },",
  "    body: JSON.stringify({ runId, payload }),",
  "  })",
  "}",
  "```",
  "",
  "Target behavior:",
  "- duplicate external events dedupe to one logical run;",
  "- failed attempts can be retried;",
  "- retries preserve the logical idempotency key;",
  "- completed runs fence later duplicate events;",
  "- proposed tests cover duplicate event, failed retry, and completed fence cases.",
  "",
  "Use Firegrid durable tools for coordination artifacts. Keep conclusions",
  "substrate-neutral: no product names or domain-specific task assumptions.",
  "Publish task-specific reasoning, patch plans, review notes, or handoff notes.",
].join("\n")

const channelSurface = [
  "Available durable channels and callable tools:",
  `- ${channels.artifacts}: publish investigation, implementation, review, finding, and final artifacts.`,
  `- ${channels.claims}: publish choreographed peer claims before doing work.`,
  `- ${channels.reports}: publish participant summaries and handoff notes.`,
  `- ${channels.scores}: publish compact self-reported run metadata when useful.`,
  `- ${channels.workerAction}: callable neutral arithmetic check; use it only as a supporting tool invocation, not as the task answer.`,
  "Use the runtime tool catalog for schemas. Do not echo a prompt-provided JSON example; choose meaningful ids, timestamps, titles, summaries, and body text from the task.",
].join("\n")

const liveRuntime = local.jsonl({
  argv: [...claudeAcpArgv],
  agent: "claude-acp",
  agentProtocol: "acp",
  cwd: globalThis.process.cwd(),
  envBindings: [
    { name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" },
  ],
  runtimeContextMcp: { enabled: true },
})

const externalId = (
  runId: string,
  arm: CoordinationTopologyArm,
  label: string,
): string => `${runId}:${arm}:${label}`

const createLiveSession = (
  firegrid: Firegrid["Type"],
  runId: string,
  arm: CoordinationTopologyArm,
  label: string,
): Effect.Effect<FiregridSessionHandle, unknown> =>
  firegrid.sessions.createOrLoad({
    externalKey: agenticPatternsExternalKey(externalId(runId, arm, label)),
    runtime: liveRuntime,
    createdBy: "tf-1fcd.coordination-topology.live",
  })

const waitForTurnComplete = (
  session: FiregridSessionHandle,
  label: string,
  timeoutMs: number,
): Effect.Effect<ParticipantRun, unknown> =>
  Effect.gen(function*() {
    let completed = false
    while (!completed) {
      const next = yield* session.wait.forAgentOutput({ timeoutMs })
      if (!next.matched) {
        return yield* Effect.fail(
          new Error(`timed out waiting for ${label} TurnComplete`),
        )
      }
      if (next.output._tag === "TurnComplete") completed = true
    }
    return {
      label,
      sessionId: session.sessionId,
      contextId: session.contextId,
      completed,
    }
  })

const promptStartWait = (
  firegrid: Firegrid["Type"],
  runId: string,
  arm: CoordinationTopologyArm,
  label: string,
  prompt: string,
): Effect.Effect<ParticipantRun, unknown> =>
  Effect.scoped(Effect.gen(function*() {
    const session = yield* createLiveSession(firegrid, runId, arm, label)
    yield* session.whenReady
    yield* session.permissions.autoApprove("allow")
    yield* session.prompt({
      payload: prompt,
      idempotencyKey: `tf-1fcd:${runId}:${arm}:${label}:initial`,
    })
    yield* session.start()
    const participant = yield* waitForTurnComplete(session, label, 180_000)
    yield* Effect.annotateCurrentSpan({
      "coordination.mode": "live-frontier",
      "coordination.arm": arm,
      "coordination.participant": label,
      "coordination.session_id": session.sessionId,
      "coordination.context_id": session.contextId,
      "coordination.lifecycle_completed": participant.completed,
    })
    return participant
  })).pipe(
    Effect.withSpan("coordination_topology.live_participant", {
      kind: "client",
      attributes: {
        "coordination.arm": arm,
        "coordination.participant": label,
      },
    }),
  )

const armRun = (
  arm: CoordinationTopologyArm,
  mode: RunMode,
  participants: ReadonlyArray<ParticipantRun>,
): ArmRun => ({
  arm,
  mode,
  participants,
})

const singlePrompt = (runId: string) => [
  "Arm A: single agent.",
  "You own investigation, patch design, self-review, and final handoff.",
  "Your artifact body must contain the concrete bug analysis and patch plan.",
  "Use the durable Firegrid tool surface before finishing:",
  `1. call ${channels.workerAction} once as a neutral arithmetic check with runId=${runId};`,
  `2. send one final artifact to ${channels.artifacts};`,
  `3. send one compact metadata row to ${channels.scores}.`,
  "",
  channelSurface,
  "",
  taskPacket,
].join("\n")

const runSingleAgent = (
  firegrid: Firegrid["Type"],
  runId: string,
): Effect.Effect<ArmRun, unknown> =>
  Effect.gen(function*() {
    const participant = yield* promptStartWait(
      firegrid,
      runId,
      "single",
      "single-agent",
      singlePrompt(runId),
    )
    // agentic-patterns-coordination-topology.TOPOLOGY_ARMS.1
    return armRun("single", "live-frontier", [participant])
  }).pipe(
    Effect.withSpan("coordination_topology.arm.single", {
      kind: "internal",
    }),
  )

const orchestrationPrompt = (
  runId: string,
  label: "investigator" | "builder" | "reviewer",
) => [
  "Arm B: developer-authored orchestration.",
  "The developer authored this fixed graph: investigator -> builder -> reviewer.",
  "Do not change the topology and do not create a manager-agent plan.",
  `Your fixed role is ${label}.`,
  "Your durable artifact must contain substantive task-specific content for this role.",
  label === "investigator"
    ? `Publish an investigation artifact to ${channels.artifacts}.`
    : `First wait_for the upstream ${label === "builder" ? "investigator" : "builder"} artifact on ${channels.artifacts}, then publish your role artifact.`,
  label === "reviewer"
    ? `Also send a score row to ${channels.scores}.`
    : `Also send a report row to ${channels.reports}.`,
  "",
  channelSurface,
  "",
  taskPacket,
  "",
  `Use runId=${runId} and arm=developer-authored-orchestration in channel payloads.`,
].join("\n")

const runDeveloperAuthoredOrchestration = (
  firegrid: Firegrid["Type"],
  runId: string,
): Effect.Effect<ArmRun, unknown> =>
  Effect.gen(function*() {
    const investigator = yield* promptStartWait(
      firegrid,
      runId,
      "developer-authored-orchestration",
      "investigator",
      orchestrationPrompt(runId, "investigator"),
    )
    const builder = yield* promptStartWait(
      firegrid,
      runId,
      "developer-authored-orchestration",
      "builder",
      orchestrationPrompt(runId, "builder"),
    )
    const reviewer = yield* promptStartWait(
      firegrid,
      runId,
      "developer-authored-orchestration",
      "reviewer",
      orchestrationPrompt(runId, "reviewer"),
    )
    // agentic-patterns-coordination-topology.TOPOLOGY_ARMS.2
    return armRun("developer-authored-orchestration", "live-frontier", [
      investigator,
      builder,
      reviewer,
    ])
  }).pipe(
    Effect.withSpan("coordination_topology.arm.developer_authored", {
      kind: "internal",
    }),
  )

const choreographyPrompt = (runId: string, label: string) => [
  "Arm C: choreography.",
  "You are a peer agent. There is no central assignment or manager.",
  `Perspective hint: ${label}. Use it to decide locally what is useful.`,
  "",
  "Watch the shared workspace. Claim useful work. Publish findings, artifacts,",
  "and review comments for peers. React to any peer claim or artifact you see.",
  "Your claim and artifact should reflect the local coordination choice you made.",
  "Use the durable Firegrid tool surface before finishing:",
  `1. send at least one claim to ${channels.claims};`,
  `2. use wait_for_any over ${channels.claims} and ${channels.artifacts};`,
  `3. send at least one artifact to ${channels.artifacts}.`,
  "",
  channelSurface,
  "",
  taskPacket,
  "",
  `Use runId=${runId} and arm=choreography in channel payloads.`,
].join("\n")

const runChoreography = (
  firegrid: Firegrid["Type"],
  runId: string,
): Effect.Effect<ArmRun, unknown> =>
  Effect.gen(function*() {
    const peers = yield* Effect.all(
      ["planner-peer", "builder-peer", "reviewer-peer"].map(label =>
        promptStartWait(
          firegrid,
          runId,
          "choreography",
          label,
          choreographyPrompt(runId, label),
        )),
      { concurrency: "unbounded" },
    )
    // agentic-patterns-coordination-topology.TOPOLOGY_ARMS.3
    // agentic-patterns-coordination-topology.TOPOLOGY_ARMS.4
    return armRun("choreography", "live-frontier", peers)
  }).pipe(
    Effect.withSpan("coordination_topology.arm.choreography", {
      kind: "internal",
    }),
  )

const fixtureSource = (runId: string): string => `
const readline = require("node:readline");
let nextId = 0;
const pending = new Map();
const runId = ${JSON.stringify(runId)};
const channels = ${JSON.stringify(channels)};
const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
const tool = (name, input, then) => {
  const toolUseId = "fixture-smoke:" + (++nextId) + ":" + name;
  pending.set(toolUseId, then);
  emit({ type: "tool_use", toolUseId, name, input });
};
const finish = () => {
  emit({ type: "text", text: "fixture smoke completed public channel-tool plumbing" });
  emit({ type: "turn_complete", finishReason: "stop" });
  setTimeout(() => process.exit(0), 250);
};
readline.createInterface({ input: process.stdin }).on("line", line => {
  const event = JSON.parse(line);
  if (event.type === "prompt") {
    tool("send", {
      channel: channels.artifacts,
      payload: {
        artifactId: runId + ":fixture-smoke:artifact",
        runId,
        arm: "fixture-smoke",
        participantId: "fixture-smoke",
        artifactType: "smoke",
        title: "non-experiment fixture smoke",
        body: "Deterministic fixture validates send tool only; it is not the experiment result.",
        createdAt: new Date().toISOString()
      }
    }, () => finish());
    return;
  }
  if (event.type === "tool_result") {
    const then = pending.get(event.toolUseId);
    pending.delete(event.toolUseId);
    if (then) then(event.content);
  }
});
`

const runFixtureSmoke = (
  firegrid: Firegrid["Type"],
  runId: string,
): Effect.Effect<CoordinationTopologyResult, unknown> =>
  Effect.gen(function*() {
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: agenticPatternsExternalKey(externalId(
        runId,
        "fixture-smoke",
        "fixture-smoke",
      )),
      runtime: local.jsonl({
        argv: [
          globalThis.process.execPath,
          "-e",
          fixtureSource(runId),
        ],
        agent: "coordination-topology-fixture-smoke",
        agentProtocol: "stdio-jsonl",
        runtimeContextMcp: { enabled: true },
      }),
      createdBy: "tf-1fcd.coordination-topology.fixture-smoke",
    })
    yield* session.whenReady
    yield* session.prompt({
      payload: "Non-experiment fixture smoke. Validate public tool plumbing only.",
      idempotencyKey: `tf-1fcd:${runId}:fixture-smoke`,
    })
    yield* session.start()
    const participant = yield* waitForTurnComplete(session, "fixture-smoke", 30_000)
    const arm = armRun("fixture-smoke", "fixture-smoke", [participant])
    // agentic-patterns-coordination-topology.FIXTURE_SMOKE.1
    // agentic-patterns-coordination-topology.FIXTURE_SMOKE.2
    return {
      mode: "fixture-smoke" as const,
      runId,
      arms: [arm],
    }
  }).pipe(
    Effect.withSpan("coordination_topology.fixture_smoke", {
      kind: "internal",
    }),
  )

const runLiveExperiment = (
  firegrid: Firegrid["Type"],
  runId: string,
): Effect.Effect<CoordinationTopologyResult, unknown> =>
  Effect.gen(function*() {
    const single = yield* runSingleAgent(firegrid, runId)
    const orchestration = yield* runDeveloperAuthoredOrchestration(firegrid, runId)
    const choreography = yield* runChoreography(firegrid, runId)
    // agentic-patterns-coordination-topology.OBSERVABILITY.5
    // agentic-patterns-coordination-topology.OBSERVABILITY.6
    return {
      mode: "live-frontier" as const,
      runId,
      arms: [single, orchestration, choreography],
    }
  })

const requireLiveCredentials = Effect.gen(function*() {
  const liveFlag = yield* liveFlagConfig
  if (liveFlag !== "1") return false
  const anthropicKey = yield* anthropicKeyConfig
  if (Option.isNone(anthropicKey)) {
    return yield* Effect.fail(
      new Error(
        "FIREGRID_COORDINATION_EXPERIMENT_LIVE=1 requires ANTHROPIC_API_KEY",
      ),
    )
  }
  return true
})

export const coordinationTopologyDriver: Effect.Effect<
  CoordinationTopologyResult,
  unknown,
  Firegrid
> = Effect.gen(function*() {
  const firegrid = yield* Firegrid
  const runId = `coordination-topology-${crypto.randomUUID()}`
  const live = yield* requireLiveCredentials
  const result = live
    ? yield* runLiveExperiment(firegrid, runId)
    : yield* runFixtureSmoke(firegrid, runId)

  const participantCount = result.arms.reduce(
    (count, arm) => count + arm.participants.length,
    0,
  )
  const completedParticipantCount = result.arms.reduce(
    (count, arm) =>
      count + arm.participants.filter(participant => participant.completed).length,
    0,
  )

  // agentic-patterns-coordination-topology.BENCH_SUBSTRATE.1
  // agentic-patterns-coordination-topology.BENCH_SUBSTRATE.2
  // agentic-patterns-coordination-topology.BENCH_SUBSTRATE.3
  // agentic-patterns-coordination-topology.OBSERVABILITY.1
  // agentic-patterns-coordination-topology.OBSERVABILITY.2
  // agentic-patterns-coordination-topology.OBSERVABILITY.3
  // agentic-patterns-coordination-topology.OBSERVABILITY.4
  // agentic-patterns-coordination-topology.OBSERVABILITY.5
  // agentic-patterns-coordination-topology.OBSERVABILITY.6
  // agentic-patterns-coordination-topology.PUBLIC_SURFACE.1
  // agentic-patterns-coordination-topology.PUBLIC_SURFACE.2
  // agentic-patterns-coordination-topology.PUBLIC_SURFACE.3
  // agentic-patterns-coordination-topology.PUBLIC_SURFACE.4
  // agentic-patterns-coordination-topology.PUBLIC_SURFACE.5
  yield* Effect.annotateCurrentSpan({
    "coordination.mode": result.mode,
    "coordination.run_id": result.runId,
    "coordination.live_arms": liveArms.join(","),
    "coordination.item_count": coordinationTopologyItemCount,
    "coordination.worker_count": coordinationTopologyWorkerCount,
    "coordination.arm_count": result.arms.length,
    "coordination.participant_count": participantCount,
    "coordination.completed_participant_count": completedParticipantCount,
    "coordination.analysis_surface":
      "trace.jsonl,simulate:show,simulate:perf,durable-channel-rows",
  })

  return result
}).pipe(
  Effect.withSpan("coordination_topology.driver", {
    kind: "internal",
  }),
)
