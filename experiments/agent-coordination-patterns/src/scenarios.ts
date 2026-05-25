import type { ExperimentScenario } from "./types.ts"

const task = (lines: ReadonlyArray<string>): string =>
  [
    "# Agent Coordination Patterns Task Packet",
    "",
    "This packet is self-contained. Do not inspect the repository, shell, or filesystem.",
    "Use only the Firegrid session and coordination-channel tools exposed to you.",
    "",
    ...lines,
    "",
    "Output contract:",
    // agent-coordination-patterns-experiment.SCENARIOS.6
    "- Produce one concise final artifact with body under 1,200 characters.",
    "- State which evidence you inspected.",
    "- State the implementation or design recommendation.",
    "- State open questions.",
    "- Do not claim coordination helped unless the artifacts show why.",
    "",
  ].join("\n")

const harnessMaterials = [
  "Provided materials:",
  "",
  "Experiment goal:",
  "Firegrid should act as the workbench for comparing three coordination patterns: one participant, a central orchestrator, and peer choreography.",
  "",
  "Current harness shape:",
  "- The driver composes a real Firegrid host in-process.",
  "- Participants are launched through the public Firegrid client/session surface.",
  "- The shared board is exposed as channels: coordination.work, coordination.claims, coordination.findings, coordination.questions, coordination.reviews, and coordination.final.",
  "- The driver injects inbound events through Firegrid.channels.send and waits for the final artifact through Firegrid.channels.waitFor.",
  "- A run is incomplete unless a coordination.final row is published.",
  "",
  "Known measurement risks:",
  "- If the task packet asks for repository or shell access, agents may burn time on unavailable tools instead of exercising Firegrid coordination.",
  "- If final artifacts are optional prose instead of channel rows, the scorer cannot reliably compare arms.",
  "- Choreography should be judged by durable board behavior, not by hidden driver state.",
] as const

// agent-coordination-patterns-experiment.SCENARIOS.1
// agent-coordination-patterns-experiment.SCENARIOS.5
const experimentScenarios = [
  {
    id: "solo-baseline",
    name: "Solo Baseline",
    axis: "coordination overhead floor",
    hypothesis:
      "A localized task with one clear owner should favor the single-agent arm; multi-agent arms should pay coordination overhead without enough upside.",
    expectedDivergence:
      "single should have lower duration, fewer spans, fewer tool calls, and comparable artifact quality.",
    taskPacket: task([
      "Scenario: Solo Baseline",
      "",
      ...harnessMaterials,
      "",
      "Task:",
      "- Identify one small documentation or workflow improvement using only the provided materials.",
      "- Return the exact change you would make and why it is enough.",
    ]),
    inboundSignals: [],
  },
  {
    id: "parallel-slices",
    name: "Parallel Independent Slices",
    axis: "parallelizable search and comparison",
    hypothesis:
      "A task with independent slices should expose whether central delegation can reduce wall-clock time without losing synthesis quality.",
    expectedDivergence:
      "central should show more session/tool activity but may beat single on duration or breadth; choreography should only help if peer discovery overhead stays low.",
    taskPacket: task([
      "Scenario: Parallel Independent Slices",
      "",
      ...harnessMaterials,
      "",
      "Task:",
      "- Evaluate three independent surfaces of this experiment setup:",
      "  1. artifact completeness;",
      "  2. trace/scoring usefulness;",
      "  3. coordination-board usefulness.",
      "- Produce a final recommendation that compares all three surfaces.",
      "- If you delegate, give each worker exactly one surface.",
    ]),
    inboundSignals: [],
  },
  {
    id: "review-revision",
    name: "Review And Revision",
    axis: "quality through critique",
    hypothesis:
      "A draft-review-revise task should reveal whether extra participants improve correctness enough to justify overhead.",
    expectedDivergence:
      "central or choreography should show explicit critique/revision evidence; single may be faster but more likely to miss edge cases.",
    taskPacket: task([
      "Scenario: Review And Revision",
      "",
      ...harnessMaterials,
      "",
      "Task:",
      "- Draft a small improvement plan for the experiment harness.",
      "- Review the plan for failure modes or measurement bias.",
      "- Revise the plan once based on the review.",
      "- The final artifact must separate draft, review findings, and revised plan.",
    ]),
    inboundSignals: [],
  },
  {
    id: "shared-board",
    name: "Shared Board Coordination",
    axis: "durable peer discovery and claim contention",
    hypothesis:
      "A task that requires shared work discovery should be the first place choreography can outperform centralized assignment, if the board channels are usable.",
    expectedDivergence:
      "choreography should produce coordination.* board rows and avoid duplicate work; central may still win if board overhead is high.",
    taskPacket: task([
      "Scenario: Shared Board Coordination",
      "",
      ...harnessMaterials,
      "",
      "Task:",
      "- Use the coordination board channels to discover work, claim work, publish findings, ask questions, review peer findings, and produce a final artifact.",
      "- Avoid duplicate work by checking existing claims before starting a slice.",
      "- The final artifact must mention which board channels were used.",
    ]),
    inboundSignals: [
      {
        atMs: 0,
        channel: "coordination.work",
        kind: "task",
        title: "Primary board task",
        body: "Inspect the task packet and claim one useful slice before working.",
        workId: "shared-board-primary",
        status: "open",
      },
      {
        atMs: 2_000,
        channel: "coordination.questions",
        kind: "question",
        title: "Late operator question",
        body: "Which coordination pattern seems to be producing duplicate work, and what evidence supports that?",
        workId: "shared-board-question",
        status: "open",
      },
    ],
  },
  {
    id: "ambiguous-debug",
    name: "Ambiguous Debug Triage",
    axis: "uncertainty decomposition",
    hypothesis:
      "A task with multiple plausible failure sources should show whether coordination improves hypothesis coverage or merely adds message overhead.",
    expectedDivergence:
      "central should show better hypothesis coverage than single; choreography should reveal whether peers can converge without a manager.",
    taskPacket: task([
      "Scenario: Ambiguous Debug Triage",
      "",
      "Task:",
      "- A Firegrid run intermittently reports either agent_silent or unknown-channel.",
      "- Inbound evidence rows will arrive on coordination.work / coordination.findings. Wait for the listed workIds before finalizing: debug-agent-silent, debug-unknown-channel, debug-trace-evidence.",
      "- Build a triage plan that distinguishes transport, routing, permission, and prompt-design causes.",
      "- Return the smallest next diagnostic and the evidence that would confirm or reject each cause.",
    ]),
    inboundSignals: [
      {
        atMs: 1_000,
        channel: "coordination.work",
        kind: "incident",
        title: "agent_silent report",
        body: "A parent session timed out with agent_silent after appending an initial prompt.",
        workId: "debug-agent-silent",
        status: "open",
      },
      {
        atMs: 2_500,
        channel: "coordination.work",
        kind: "incident",
        title: "unknown-channel report",
        body: "A child-output wait failed with UnknownChannelTarget for session.agent_output.",
        workId: "debug-unknown-channel",
        status: "open",
      },
      {
        atMs: 4_000,
        channel: "coordination.findings",
        kind: "evidence",
        title: "trace excerpt",
        body: "Trace shows no error spans before the timeout, but no session.agent_output rows after sequence 2.",
        workId: "debug-trace-evidence",
        status: "published",
      },
    ],
  },
  {
    id: "webhook-burst",
    name: "Webhook Burst Triage",
    axis: "bursty inbound event load",
    hypothesis:
      "Bursty inbound events should reveal whether arms can deduplicate, prioritize, and avoid over-coordinating under load.",
    expectedDivergence:
      "single may process linearly; central should delegate independent incidents; choreography should show durable claims preventing duplicate work.",
    taskPacket: task([
      "Scenario: Webhook Burst Triage",
      "",
      "Task:",
      "- Watch coordination.work for inbound webhook incidents.",
      // agent-coordination-patterns-experiment.SCENARIOS.7
      "- Wait for these inbound workIds on coordination.work before finalizing: linear:TF-101:a, linear:TF-102:a, linear:TF-101:duplicate, github:check:failed.",
      "- Use scalar matches such as match.workId for those waits; do not guess payload timestamps.",
      "- Group duplicate incidents by external entity.",
      "- Triage severity and publish findings.",
      "- The final artifact must list the deduped incident groups and which evidence rows supported each group.",
    ]),
    inboundSignals: [
      {
        atMs: 0,
        channel: "coordination.work",
        kind: "webhook",
        title: "linear.issue.updated TF-101",
        body: "Issue TF-101 changed labels from bug to regression.",
        workId: "linear:TF-101:a",
        status: "open",
      },
      {
        atMs: 250,
        channel: "coordination.work",
        kind: "webhook",
        title: "linear.issue.updated TF-102",
        body: "Issue TF-102 received a customer escalation comment.",
        workId: "linear:TF-102:a",
        status: "open",
      },
      {
        atMs: 500,
        channel: "coordination.work",
        kind: "webhook",
        title: "linear.issue.updated TF-101 duplicate",
        body: "Duplicate delivery for TF-101 with the same external event id.",
        workId: "linear:TF-101:duplicate",
        status: "open",
      },
      {
        atMs: 1_500,
        channel: "coordination.work",
        kind: "webhook",
        title: "github.check.failed",
        body: "CI failed for a related branch; failure signature mentions unknown-channel.",
        workId: "github:check:failed",
        status: "open",
      },
    ],
  },
] as const satisfies ReadonlyArray<ExperimentScenario>

const defaultScenarioIds = [
  "solo-baseline",
  "parallel-slices",
  "review-revision",
] as const

const scenarioById: ReadonlyMap<string, ExperimentScenario> = new Map(
  experimentScenarios.map(scenario => [scenario.id, scenario] as const),
)

export const parseScenarioIds = (
  value: string | undefined,
): ReadonlyArray<string> => {
  if (value === undefined || value.length === 0) return [...defaultScenarioIds]
  if (value === "all") return experimentScenarios.map(scenario => scenario.id)
  return value.split(",").map(part => part.trim()).filter(Boolean)
}

export const resolveScenarios = (
  ids: ReadonlyArray<string>,
): ReadonlyArray<ExperimentScenario> =>
  ids.map((id) => {
    const scenario = scenarioById.get(id)
    if (scenario === undefined) {
      throw new Error(`Unknown scenario ${JSON.stringify(id)}`)
    }
    return scenario
  })
