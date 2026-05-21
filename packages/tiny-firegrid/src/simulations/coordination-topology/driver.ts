import {
  Firegrid,
  local,
  type FiregridSessionHandle,
  type RuntimeAgentOutputObservation,
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
type CoordinationTopologyVerdict = "GREEN" | "INCONCLUSIVE"

interface ToolUseEvidence {
  readonly name: string
  readonly channels: ReadonlyArray<string>
}

interface ParticipantEvidence {
  readonly label: string
  readonly sessionId: string
  readonly contextId: string
  readonly toolUses: ReadonlyArray<ToolUseEvidence>
  readonly toolNames: ReadonlyArray<string>
  readonly text: string
  readonly sawMarker: boolean
}

interface ArmResult {
  readonly arm: CoordinationTopologyArm
  readonly mode: RunMode
  readonly participants: ReadonlyArray<ParticipantEvidence>
  readonly toolUseCount: number
  readonly markerCount: number
}

interface CoordinationTopologyResult {
  readonly verdict: CoordinationTopologyVerdict
  readonly mode: RunMode
  readonly arms: ReadonlyArray<ArmResult>
  readonly missingEvidence: ReadonlyArray<string>
}

const liveFlagConfig = Config.string("FIREGRID_COORDINATION_EXPERIMENT_LIVE")
  .pipe(Config.withDefault("0"))
const anthropicKeyConfig = Config.string("ANTHROPIC_API_KEY").pipe(Config.option)

const claudeAcpArgv = [
  "npx",
  "-y",
  "@agentclientprotocol/claude-agent-acp@0.36.1",
] as const

const doneMarker = "FIREGRID_COORDINATION_EXPERIMENT_DONE"

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
  "You are comparing coordination patterns on a small technical task.",
  "Produce a patch-plan artifact for this pseudo TypeScript defect:",
  "",
  "```ts",
  "type Line = { price: number; quantity: number; discountPct?: number }",
  "export const invoiceTotal = (lines: ReadonlyArray<Line>, taxPct: number) =>",
  "  lines.reduce((sum, line) => sum + line.price * line.quantity, 0) * (1 + taxPct)",
  "```",
  "",
  "Correct behavior: apply each line discount before tax; reject negative prices,",
  "negative quantities, and taxPct outside [0, 1]; keep the function pure and",
  "idempotent; include edge cases and a compact review note.",
  "",
  "Durable channels/tools available through Firegrid MCP:",
  `- send(${channels.claims}) claim rows`,
  `- send(${channels.artifacts}) investigation/implementation/review/final artifacts`,
  `- send(${channels.reports}) participant summaries`,
  `- send(${channels.scores}) score evidence rows`,
  `- call(${channels.workerAction}) deterministic arithmetic check`,
  "",
  "End your answer with one exact marker line:",
  `${doneMarker}: <short summary>`,
].join("\n")

const isoTimestampInstruction =
  "Use an ISO timestamp string for createdAt, for example 2026-05-21T00:00:00.000Z."

const jsonExample = (value: unknown): string => JSON.stringify(value, null, 2)

const artifactTypeFor = (label: string): string => {
  if (label === "investigator") return "investigation"
  if (label === "builder") return "implementation"
  if (label === "reviewer") return "review"
  if (label.endsWith("-peer")) return "finding"
  return "final"
}

const artifactExample = (
  runId: string,
  arm: CoordinationTopologyArm,
  participantId: string,
): string =>
  jsonExample({
    channel: channels.artifacts,
    payload: {
      artifactId: `${runId}:${arm}:${participantId}:artifact`,
      runId,
      arm,
      participantId,
      artifactType: artifactTypeFor(participantId),
      title: `${participantId} artifact`,
      body: "Concise technical artifact body.",
      createdAt: "2026-05-21T00:00:00.000Z",
    },
  })

const reportExample = (
  runId: string,
  arm: CoordinationTopologyArm,
  participantId: string,
): string =>
  jsonExample({
    channel: channels.reports,
    payload: {
      reportId: `${runId}:${arm}:${participantId}:report`,
      runId,
      arm,
      itemId: "invoice-total",
      workerId: participantId,
      summary: "Concise participant summary.",
      path: [participantId],
      createdAt: "2026-05-21T00:00:00.000Z",
    },
  })

const scoreExample = (
  runId: string,
  arm: CoordinationTopologyArm,
  topology: string,
): string =>
  jsonExample({
    channel: channels.scores,
    payload: {
      scoreId: `${runId}:${arm}:score`,
      runId,
      arm,
      itemCount: coordinationTopologyItemCount,
      workerCount: coordinationTopologyWorkerCount,
      dispatchCount: arm === "developer-authored-orchestration" ? 2 : 0,
      claimCount: arm === "choreography" ? 3 : 0,
      artifactCount: arm === "choreography" ? 3 : 1,
      reportCount: arm === "developer-authored-orchestration" ? 2 : 1,
      totalResultValue: 0,
      topology,
    },
  })

const workerActionExample = (runId: string, participantId: string): string =>
  jsonExample({
    channel: channels.workerAction,
    request: {
      runId,
      arm: "single",
      itemId: "invoice-total",
      inputValue: 7,
      workerId: participantId,
      participantId,
    },
  })

const waitForArtifactExample = (
  runId: string,
  participantId: "investigator" | "builder",
): string =>
  jsonExample({
    channel: channels.artifacts,
    match: {
      runId,
      arm: "developer-authored-orchestration",
      participantId,
    },
    timeoutMs: 120_000,
  })

const claimExample = (runId: string, participantId: string): string =>
  jsonExample({
    channel: channels.claims,
    payload: {
      claimId: `${runId}:choreography:${participantId}:claim`,
      runId,
      arm: "choreography",
      itemId: "invoice-total",
      workerId: participantId,
      title: `${participantId} local claim`,
      decision: "claimed",
      createdAt: "2026-05-21T00:00:00.000Z",
    },
  })

const waitForAnyExample = (runId: string): string =>
  jsonExample({
    channels: [
      {
        channel: channels.claims,
        match: { runId, arm: "choreography" },
      },
      {
        channel: channels.artifacts,
        match: { runId, arm: "choreography" },
      },
    ],
    timeoutMs: 120_000,
  })

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

const textDelta = (
  observation: RuntimeAgentOutputObservation,
): string | undefined =>
  observation._tag === "TextChunk" ? observation.event.part.delta : undefined

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const toolChannels = (input: unknown): ReadonlyArray<string> => {
  if (!isRecord(input)) return []
  const channel = input["channel"]
  if (typeof channel === "string") return [channel]
  const channelsInput = input["channels"]
  if (!Array.isArray(channelsInput)) return []
  return channelsInput.flatMap(descriptor =>
    isRecord(descriptor) && typeof descriptor["channel"] === "string"
      ? [descriptor["channel"]]
      : [])
}

const evidenceFromSession = (
  session: FiregridSessionHandle,
  label: string,
  timeoutMs: number,
): Effect.Effect<ParticipantEvidence, unknown> =>
  Effect.gen(function*() {
    const toolUses: Array<ToolUseEvidence> = []
    let text = ""
    let sawMarker = false
    let sawTurnComplete = false
    while (!sawMarker && !sawTurnComplete) {
      const next = yield* session.wait.forAgentOutput({ timeoutMs })
      if (!next.matched) break
      if (next.output._tag === "ToolUse" && next.output.toolName !== undefined) {
        toolUses.push({
          name: next.output.toolName,
          channels: toolChannels(next.output.event.part.params),
        })
      }
      if (next.output._tag === "TurnComplete") {
        sawTurnComplete = true
      }
      const delta = textDelta(next.output)
      if (delta !== undefined) {
        text += delta
        if (text.includes(doneMarker)) sawMarker = true
      }
    }
    return {
      label,
      sessionId: session.sessionId,
      contextId: session.contextId,
      toolUses,
      toolNames: [...new Set(toolUses.map(toolUse => toolUse.name))].sort(),
      text,
      sawMarker,
    }
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

const promptStartObserve = (
  firegrid: Firegrid["Type"],
  runId: string,
  arm: CoordinationTopologyArm,
  label: string,
  prompt: string,
): Effect.Effect<ParticipantEvidence, unknown> =>
  Effect.scoped(Effect.gen(function*() {
    const session = yield* createLiveSession(firegrid, runId, arm, label)
    yield* session.whenReady
    yield* session.permissions.autoApprove("allow")
    yield* session.prompt({
      payload: prompt,
      idempotencyKey: `tf-1fcd:${runId}:${arm}:${label}:initial`,
    })
    yield* session.start()
    const evidence = yield* evidenceFromSession(session, label, 180_000)
    yield* Effect.annotateCurrentSpan({
      "coordination.mode": "live-frontier",
      "coordination.arm": arm,
      "coordination.participant": label,
      "coordination.tool_names": evidence.toolNames.join(","),
      "coordination.saw_marker": evidence.sawMarker,
      "coordination.text_length": evidence.text.length,
    })
    return evidence
  })).pipe(
    Effect.withSpan("coordination_topology.live_participant", {
      kind: "client",
      attributes: {
        "coordination.arm": arm,
        "coordination.participant": label,
      },
    }),
  )

const armResult = (
  arm: CoordinationTopologyArm,
  mode: RunMode,
  participants: ReadonlyArray<ParticipantEvidence>,
): ArmResult => ({
  arm,
  mode,
  participants,
  toolUseCount: participants.reduce(
    (count, participant) => count + participant.toolNames.length,
    0,
  ),
  markerCount: participants.filter(participant => participant.sawMarker).length,
})

const participantByLabel = (
  arm: ArmResult,
  label: string,
): ParticipantEvidence | undefined =>
  arm.participants.find(participant => participant.label === label)

const sawToolChannel = (
  participant: ParticipantEvidence | undefined,
  name: string,
  channel: string,
): boolean =>
  participant?.toolUses.some(toolUse =>
    toolUse.name === name && toolUse.channels.includes(channel)) ?? false

const missingParticipantEvidence = (
  arm: CoordinationTopologyArm,
  participant: ParticipantEvidence | undefined,
  label: string,
  requirements: ReadonlyArray<{
    readonly name: string
    readonly channel: string
  }>,
): ReadonlyArray<string> => {
  const missing: Array<string> = []
  if (participant === undefined) {
    return [`${arm}/${label}:missing-participant`]
  }
  if (!participant.sawMarker) {
    missing.push(`${arm}/${label}:missing-marker`)
  }
  return [
    ...missing,
    ...requirements.flatMap(requirement =>
      sawToolChannel(participant, requirement.name, requirement.channel)
        ? []
        : [`${arm}/${label}:missing-${requirement.name}-${requirement.channel}`],
    ),
  ]
}

export const validateLiveEvidence = (
  arms: ReadonlyArray<ArmResult>,
): ReadonlyArray<string> => {
  const armByName = new Map(arms.map(arm => [arm.arm, arm]))
  const missing: Array<string> = []
  const single = armByName.get("single")
  if (single === undefined) {
    missing.push("single:missing-arm")
  } else {
    missing.push(...missingParticipantEvidence(
      "single",
      participantByLabel(single, "single-agent"),
      "single-agent",
      [
        { name: "call", channel: channels.workerAction },
        { name: "send", channel: channels.artifacts },
        { name: "send", channel: channels.scores },
      ],
    ))
  }

  const orchestration = armByName.get("developer-authored-orchestration")
  if (orchestration === undefined) {
    missing.push("developer-authored-orchestration:missing-arm")
  } else {
    missing.push(...missingParticipantEvidence(
      "developer-authored-orchestration",
      participantByLabel(orchestration, "investigator"),
      "investigator",
      [{ name: "send", channel: channels.artifacts }],
    ))
    missing.push(...missingParticipantEvidence(
      "developer-authored-orchestration",
      participantByLabel(orchestration, "builder"),
      "builder",
      [
        { name: "wait_for", channel: channels.artifacts },
        { name: "send", channel: channels.artifacts },
      ],
    ))
    missing.push(...missingParticipantEvidence(
      "developer-authored-orchestration",
      participantByLabel(orchestration, "reviewer"),
      "reviewer",
      [
        { name: "wait_for", channel: channels.artifacts },
        { name: "send", channel: channels.artifacts },
        { name: "send", channel: channels.scores },
      ],
    ))
  }

  const choreography = armByName.get("choreography")
  if (choreography === undefined) {
    missing.push("choreography:missing-arm")
  } else {
    missing.push(
      ...["planner-peer", "builder-peer", "reviewer-peer"].flatMap(label =>
        missingParticipantEvidence(
          "choreography",
          participantByLabel(choreography, label),
          label,
          [
            { name: "send", channel: channels.claims },
            { name: "wait_for_any", channel: channels.claims },
            { name: "wait_for_any", channel: channels.artifacts },
            { name: "send", channel: channels.artifacts },
          ],
        )),
    )
  }
  return missing
}

const singlePrompt = (runId: string) => [
  "Arm A: single agent.",
  "You own planning, implementation design, self-review, and final handoff.",
  "Use Firegrid durable tools before answering:",
  `1. call ${channels.workerAction} at least once with runId=${runId}, arm=single.`,
  `2. send one final artifact to ${channels.artifacts}.`,
  `3. send one score evidence row to ${channels.scores}.`,
  "",
  "Exact tool input shapes to use:",
  "call input:",
  workerActionExample(runId, "single-agent"),
  "send artifact input:",
  artifactExample(runId, "single", "single-agent"),
  "send score input:",
  scoreExample(runId, "single", "single-agent"),
  isoTimestampInstruction,
  "",
  taskPacket,
].join("\n")

const runSingleAgent = (
  firegrid: Firegrid["Type"],
  runId: string,
): Effect.Effect<ArmResult, unknown> =>
  Effect.gen(function*() {
    const participant = yield* promptStartObserve(
      firegrid,
      runId,
      "single",
      "single-agent",
      singlePrompt(runId),
    )
    // agentic-patterns-coordination-topology.TOPOLOGY_ARMS.1
    return armResult("single", "live-frontier", [participant])
  }).pipe(
    Effect.withSpan("coordination_topology.arm.single", {
      kind: "internal",
    }),
  )

const orchestrationPrompt = (
  runId: string,
  label: "investigator" | "builder" | "reviewer",
  upstream: string,
) => [
  "Arm B: developer-authored orchestration.",
  "The developer authored a fixed investigator -> builder -> reviewer graph.",
  "Do not change the decomposition or create a manager-agent plan.",
  `Your fixed role is ${label}.`,
  label === "investigator"
    ? `Publish an investigation artifact to ${channels.artifacts}.`
    : `First wait_for the upstream artifact on ${channels.artifacts}, then publish your role artifact.`,
  label === "reviewer"
    ? `Also send a score evidence row to ${channels.scores}.`
    : `Also send a report row to ${channels.reports}.`,
  "",
  "Exact tool input shapes to use:",
  ...(label === "investigator"
    ? []
    : [
      "wait_for input:",
      waitForArtifactExample(
        runId,
        label === "builder" ? "investigator" : "builder",
      ),
    ]),
  "send artifact input:",
  artifactExample(runId, "developer-authored-orchestration", label),
  label === "reviewer" ? "send score input:" : "send report input:",
  label === "reviewer"
    ? scoreExample(
      runId,
      "developer-authored-orchestration",
      "investigator-builder-reviewer",
    )
    : reportExample(runId, "developer-authored-orchestration", label),
  isoTimestampInstruction,
  "",
  upstream,
  "",
  taskPacket,
  "",
  `Use runId=${runId} and arm=developer-authored-orchestration in channel payloads.`,
].join("\n")

const runDeveloperAuthoredOrchestration = (
  firegrid: Firegrid["Type"],
  runId: string,
): Effect.Effect<ArmResult, unknown> =>
  Effect.gen(function*() {
    const investigator = yield* promptStartObserve(
      firegrid,
      runId,
      "developer-authored-orchestration",
      "investigator",
      orchestrationPrompt(runId, "investigator", "No upstream artifact."),
    )
    const builder = yield* promptStartObserve(
      firegrid,
      runId,
      "developer-authored-orchestration",
      "builder",
      orchestrationPrompt(runId, "builder", investigator.text),
    )
    const reviewer = yield* promptStartObserve(
      firegrid,
      runId,
      "developer-authored-orchestration",
      "reviewer",
      orchestrationPrompt(runId, "reviewer", builder.text),
    )
    // agentic-patterns-coordination-topology.TOPOLOGY_ARMS.2
    return armResult("developer-authored-orchestration", "live-frontier", [
      investigator,
      builder,
      reviewer,
    ])
  }).pipe(
    Effect.withSpan("coordination_topology.arm.developer_authored", {
      kind: "internal",
    }),
  )

const choreographyPrompt = (
  runId: string,
  label: string,
) => [
  "Arm C: choreography.",
  "You are a peer agent, not a centrally assigned worker.",
  `Peer hint: ${label}. Use it as a perspective, not an exclusive assignment.`,
  "",
  "Watch the shared workspace. Claim useful work. Publish findings, artifacts,",
  "and review comments for peers. React to any peer claim or artifact you see.",
  "Required durable behavior before your final answer:",
  `1. send at least one claim to ${channels.claims};`,
  `2. use wait_for_any over ${channels.claims} and ${channels.artifacts};`,
  `3. send at least one artifact to ${channels.artifacts};`,
  "4. end with the exact marker line.",
  "",
  "Exact tool input shapes to use:",
  "send claim input:",
  claimExample(runId, label),
  "wait_for_any input:",
  waitForAnyExample(runId),
  "send artifact input:",
  artifactExample(runId, "choreography", label),
  isoTimestampInstruction,
  "",
  taskPacket,
  "",
  `Use runId=${runId} and arm=choreography in channel payloads.`,
].join("\n")

const runChoreography = (
  firegrid: Firegrid["Type"],
  runId: string,
): Effect.Effect<ArmResult, unknown> =>
  Effect.gen(function*() {
    const peers = yield* Effect.all(
      ["planner-peer", "builder-peer", "reviewer-peer"].map(label =>
        promptStartObserve(
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
    return armResult("choreography", "live-frontier", peers)
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
const marker = ${JSON.stringify(doneMarker)};
const channels = ${JSON.stringify(channels)};
const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
const tool = (name, input, then) => {
  const toolUseId = "fixture-smoke:" + (++nextId) + ":" + name;
  pending.set(toolUseId, then);
  emit({ type: "tool_use", toolUseId, name, input });
};
const finish = () => {
  emit({ type: "text", text: marker + ": fixture smoke validated public channel tool plumbing" });
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
    const participant = yield* evidenceFromSession(session, "fixture-smoke", 30_000)
    const arm = armResult("fixture-smoke", "fixture-smoke", [participant])
    // agentic-patterns-coordination-topology.FIXTURE_SMOKE.1
    // agentic-patterns-coordination-topology.FIXTURE_SMOKE.2
    return {
      verdict: "GREEN" as const,
      mode: "fixture-smoke" as const,
      arms: [arm],
      missingEvidence: [],
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
    const arms = [single, orchestration, choreography]
    const missingEvidence = validateLiveEvidence(arms)
    // agentic-patterns-coordination-topology.OBSERVABILITY.5
    return {
      verdict: missingEvidence.length === 0
        ? "GREEN" as const
        : "INCONCLUSIVE" as const,
      mode: "live-frontier" as const,
      arms,
      missingEvidence,
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

  // agentic-patterns-coordination-topology.BENCH_SUBSTRATE.1
  // agentic-patterns-coordination-topology.BENCH_SUBSTRATE.2
  // agentic-patterns-coordination-topology.BENCH_SUBSTRATE.3
  // agentic-patterns-coordination-topology.OBSERVABILITY.1
  // agentic-patterns-coordination-topology.OBSERVABILITY.2
  // agentic-patterns-coordination-topology.OBSERVABILITY.3
  // agentic-patterns-coordination-topology.OBSERVABILITY.4
  // agentic-patterns-coordination-topology.OBSERVABILITY.5
  // agentic-patterns-coordination-topology.PUBLIC_SURFACE.1
  // agentic-patterns-coordination-topology.PUBLIC_SURFACE.2
  // agentic-patterns-coordination-topology.PUBLIC_SURFACE.3
  // agentic-patterns-coordination-topology.PUBLIC_SURFACE.4
  yield* Effect.annotateCurrentSpan({
    "coordination.mode": result.mode,
    "coordination.verdict": result.verdict,
    "coordination.live_arms": liveArms.join(","),
    "coordination.item_count": coordinationTopologyItemCount,
    "coordination.worker_count": coordinationTopologyWorkerCount,
    "coordination.arm_count": result.arms.length,
    "coordination.tool_use_count": result.arms
      .reduce((count, arm) => count + arm.toolUseCount, 0),
    "coordination.marker_count": result.arms
      .reduce((count, arm) => count + arm.markerCount, 0),
    "coordination.missing_evidence_count": result.missingEvidence.length,
    "coordination.missing_evidence": result.missingEvidence.join("|"),
    "coordination.participant_evidence": result.arms
      .flatMap(arm => arm.participants.map(participant =>
        `${arm.arm}/${participant.label}:${
          participant.toolUses
            .map(toolUse => `${toolUse.name}(${toolUse.channels.join("+")})`)
            .join("+")
        }`))
      .join("|"),
  })

  return result
}).pipe(
  Effect.withSpan("coordination_topology.driver", {
    kind: "internal",
  }),
)
