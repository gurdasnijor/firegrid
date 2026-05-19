import {
  Firegrid,
  local,
  type RuntimeAgentOutputObservation,
} from "@firegrid/client-sdk/firegrid"
import {
  darkFactoryClaudeAcpEnvPolicy,
  darkFactoryFactTableLayerOptions,
  DarkFactoryFactTable,
  tinyDarkFactoryPipeline,
  type DarkFactoryFactRow,
} from "../configurations/dark-factory-pipeline.ts"
import type { TinyFiregridSimulation, TinyFiregridSimulationEnv } from "./types.ts"
import { Clock, Effect, Schedule } from "effect"

/* eslint-disable local/no-fixed-polling -- firegrid-observability.TINY_FIREGRID_SIMULATIONS.1 public-client simulation observation backoff. */

interface DarkFactoryFinding {
  readonly id: string
  readonly status: "known-gap" | "observed"
  readonly expectedPublicSurface: string
  readonly evidence: string
}

interface DarkFactoryPipelineSimulationResult {
  readonly factoryRunKey: string
  readonly plannerContextId: string
  readonly triggerFactInserted: boolean
  readonly seededFactEventTypes: ReadonlyArray<string>
  readonly fullLoopStages: ReadonlyArray<string>
  readonly sawReady: boolean
  readonly sawPermissionRequest: boolean
  readonly sawTurnComplete: boolean
  readonly sawAgentError: boolean
  readonly agentError: string | undefined
  readonly sawTerminated: boolean
  readonly terminatedExitCode: number | undefined
  readonly observedToolNames: ReadonlyArray<string>
  readonly resultText: string
  readonly findings: ReadonlyArray<DarkFactoryFinding>
}

const claudeAcpArgv = ["claude-agent-acp"] as const

const darkFactorySource = "linear.oauth"
const darkFactoryFactSource = "darkFactory.facts"
const repoHint = "gurdasnijor/firegrid"

const fullLoopStages = [
  "trigger",
  "clarify",
  "plan",
  "plan-approval",
  "plan-revision-or-rejection",
  "implementer-delegation",
  "pr-opened",
  "review-kind-selection",
  "single-reviewer-or-council",
  "implementer-feedback-revision",
  "merge-signoff",
  "durable-ci-watch",
  "merge",
  "ci-failure-repair",
  "clean-unwind",
] as const

const darkFactoryFactEventTypes = [
  "factory.trigger.accepted",
  "human.clarification.requested",
  "human.clarification.answered",
  "factory.plan.proposed",
  "human.plan.approved",
  "human.plan.rejected",
  "factory.plan.revision_requested",
  "factory.run.closed",
  "factory.child.session.started",
  "github.pr.opened",
  "github.pr.review_posted",
  "github.pr.review_changes_requested",
  "github.pr.review_approved",
  "human.merge.approved",
  "human.merge.rejected",
  "github.ci.status",
  "github.pr.merged",
  "github.pr.closed",
  "factory.unwind.completed",
] as const

const staticChoreographyFindings: ReadonlyArray<DarkFactoryFinding> = [
  {
    id: "dark-factory.wait_for.caller_owned_fact_source",
    status: "known-gap",
    expectedPublicSurface:
      "wait_for can target app-owned darkFactory.facts rows for clarification answers, human approvals, PR events, review verdicts, CI status, merge decisions, and unwind completion.",
    evidence:
      "packages/protocol/src/agent-tools/schema.ts exposes wait_for RuntimeWaitSource as AgentOutput | RuntimeRun only.",
  },
  {
    id: "dark-factory.execute.provider_side_effect",
    status: "known-gap",
    expectedPublicSurface:
      "execute can invoke advertised provider capabilities for PR open/find, review/comment upsert, CI fetch, merge, close, and provider evidence writes.",
    evidence:
      "packages/host-sdk/src/host/agent-tool-host-live.ts currently returns unsupportedAgentTool for execute.",
  },
  {
    id: "dark-factory.session_cancel_close.clean_unwind",
    status: "known-gap",
    expectedPublicSurface:
      "session_cancel and session_close can abandon or close child work when any human gate rejects the run.",
    evidence:
      "packages/host-sdk/src/host/agent-tool-host-live.ts currently returns unsupportedAgentTool for session_cancel and session_close.",
  },
]

const stringifyUnknown = (value: unknown): string => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

const makeFactoryRunKey = (env: TinyFiregridSimulationEnv): string =>
  `${darkFactorySource}:issue-${env.runId}`

const makeTriggerFact = (
  env: TinyFiregridSimulationEnv,
): DarkFactoryFactRow => {
  const externalEntityKey = `issue-${env.runId}`
  return {
    factId: `${darkFactorySource}:${env.runId}:factory.trigger.accepted`,
    source: darkFactorySource,
    externalEventKey: `trigger-${env.runId}`,
    externalEntityKey,
    eventType: "factory.trigger.accepted",
    correlationId: env.runId,
    stage: "trigger",
    status: "accepted",
    acceptedAt: new Date().toISOString(),
    payload: {
      delivery: "tiny-firegrid.simulate",
      linearIssueId: externalEntityKey,
      linearIdentifier: "TF-SIM-1",
      title: "Dark Factory tiny-firegrid choreography simulation",
      url: "https://linear.example/tiny-firegrid/TF-SIM-1",
      description:
        "Exercise the fully imagined dark-factory choreography path without an app-authored phase chain. The planner must use Firegrid tools where public surfaces exist and report gaps where they do not.",
      repoHint,
    },
  }
}

const seedTriggerFact = (
  env: TinyFiregridSimulationEnv,
): Effect.Effect<boolean, unknown> =>
  Effect.scoped(
    Effect.gen(function*() {
      const table = yield* DarkFactoryFactTable
      const result = yield* table.facts.insertOrGet(makeTriggerFact(env))
      return result._tag === "Inserted"
    }).pipe(
      Effect.provide(
        DarkFactoryFactTable.layer(
          darkFactoryFactTableLayerOptions({
            baseUrl: env.durableStreamsBaseUrl,
            namespace: env.namespace,
          }),
        ),
      ),
    ),
  )

const plannerPrompt = (input: {
  readonly env: TinyFiregridSimulationEnv
  readonly parentContextId: string
  readonly factoryRunKey: string
  readonly triggerFact: DarkFactoryFactRow
}): string => {
  const payload = input.triggerFact.payload as {
    readonly linearIssueId: string
    readonly linearIdentifier: string
    readonly title: string
    readonly url: string
    readonly description: string
  }
  return [
    "You are the Smithery dark-factory planner running on Firegrid.",
    "",
    "Goal:",
    "Turn the Linear issue below into a reviewed, permissioned, CI-green, merged engineering result when approvals allow it.",
    "You own sequencing. There is no hidden workflow DAG. Decide the next action",
    "from durable facts, runtime history, repository state, and human decisions.",
    "",
    "Factory run:",
    `- parentContextId: ${input.parentContextId}`,
    `- factoryRunKey: ${input.factoryRunKey}`,
    `- factSource: ${darkFactoryFactSource}`,
    `- fullLoopStages: ${fullLoopStages.join(" -> ")}`,
    "- runtime sources:",
    "  - firegrid.runtime.runs",
    "  - firegrid.runtime.output.events",
    "  - firegrid.runtime.output.logs",
    "  - firegrid.runtime.ingress.inputs",
    "  - firegrid.runtime.ingress.deliveries",
    "  - firegrid.runtime.agent-output-events",
    "",
    "Accepted trigger fact already written at the app edge:",
    JSON.stringify(input.triggerFact, null, 2),
    "",
    "App-owned durable fact event types the edge/provider mocks may write:",
    ...darkFactoryFactEventTypes.map(eventType => `- ${eventType}`),
    "",
    "Linear issue:",
    `- issueId: ${payload.linearIssueId}`,
    `- identifier: ${payload.linearIdentifier}`,
    `- title: ${payload.title}`,
    `- url: ${payload.url}`,
    "- description:",
    payload.description,
    "",
    "Repository:",
    `- repoHint: ${repoHint}`,
    `- deterministicBranch: factory/${payload.linearIdentifier.toLowerCase()}`,
    "",
    "Provider capabilities available through execute, if advertised:",
    "- github.openPullRequest",
    "- github.findPrByHead",
    "- github.fetchPr",
    "- github.fetchPrDiff",
    "- github.upsertPrComment",
    "- github.fetchCiStatus",
    "- github.closePullRequest",
    "- github.squashMergePullRequest",
    "- linear.postComment",
    "- linear.closeRun",
    "",
    "Full §6 choreography contract:",
    "1. Ticket arrives: read the accepted trigger fact and decide whether the ticket is actionable.",
    "2. Optional clarify: if the ticket is ambiguous, ask a focused question and wait durably for human.clarification.answered. If the public wait surface cannot target that fact, report the gap.",
    "3. Plan: produce a concise plan and request human approval before implementation. Prefer ACP PermissionRequest if available; otherwise wait for human.plan.approved or human.plan.rejected.",
    "4. Revision loop: on human.plan.revision_requested or rejection-with-feedback, revise the plan and request approval again. On clean rejection, close the run cleanly and unwind child work.",
    "5. Implementer delegation: use session_new for the implementer with the plan, issue context, repo, deterministic branch, parent context id, and fact correlation ids. Wait for the implementer to report github.pr.opened or terminal failure.",
    "6. Review selection: when a PR exists, decide review shape. A typo gets one reviewer. Architectural or high-risk work gets multiple reviewer sessions with distinct prompts and, if expressible, distinct agent/model backends.",
    "7. Review loop: wait for review verdicts. If changes are requested, use session_prompt to send feedback to the implementer and wait for a PR revision or updated github.pr.opened/github.ci.status fact.",
    "8. Merge sign-off: after review approval, request human.merge.approved or human.merge.rejected. On rejection, unwind cleanly.",
    "9. CI watch: after merge approval, wait durably for github.ci.status green. Use schedule_me for bounded rechecks when no durable CI event has arrived. On failure, prompt the implementer with CI evidence and wait for a fix.",
    "10. Merge: when CI is green and merge is approved, use execute only if a merge provider capability is available, then wait for github.pr.merged evidence.",
    "11. Clean unwind: on rejection at any gate, cancel or close child sessions with session_cancel/session_close where available, record a terminal outcome, and leave durable history inspectable.",
    "",
    "Tool-use rules:",
    `1. Use wait_for over ${darkFactoryFactSource} or Firegrid runtime observation sources for human gates, CI/provider facts, child session status, and external events. Do not rely on callback URLs or hidden comments for resume.`,
    "2. Use session_new to create implementer, reviewer, council, and QA child sessions when needed.",
    "3. Use session_prompt for follow-up work on an existing child session.",
    "4. Use schedule_me for future self rechecks, especially CI still pending or provider eventual consistency.",
    "5. Use execute only for advertised provider/sandbox capabilities. Record or wait for durable facts that confirm side effects.",
    "6. Use sleep only as short local backoff; do not use it for human or provider waits.",
    "7. If blocked, emit a clear permission request or wait_for target describing exactly what fact/input will resume the run.",
    "",
    "Hard halt rule for this simulation:",
    "If a needed step is not expressible through the Firegrid tools you can see, do not invent an app-side workflow or pretend progress.",
    "Instead write one line beginning with DARK_FACTORY_FINDING and name: what you needed, what public tool/channel you expected, and what is missing.",
    "",
    "Start by:",
    "1. Inspecting the ticket and repository hint.",
    "2. Deciding whether clarification is needed.",
    "3. Producing a concise implementation plan if actionable.",
    "4. Requesting plan approval, or waiting on a human.plan.approved / human.plan.rejected fact if permission requests are unavailable.",
  ].join("\n")
}

const darkFactoryDriver = (
  env: TinyFiregridSimulationEnv,
): Effect.Effect<DarkFactoryPipelineSimulationResult, unknown, Firegrid> =>
  Effect.gen(function*() {
    if (env.processEnv.ANTHROPIC_API_KEY === undefined || env.processEnv.ANTHROPIC_API_KEY.length === 0) {
      return yield* Effect.fail(new Error(
        "dark-factory-pipeline requires ANTHROPIC_API_KEY for claude-agent-acp",
      ))
    }

    const firegrid = yield* Firegrid
    const triggerFactInserted = yield* seedTriggerFact(env)
    const factoryRunKey = makeFactoryRunKey(env)
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: {
        source: "tiny-firegrid.dark-factory",
        id: factoryRunKey,
      },
      runtime: local.jsonl({
        argv: [...claudeAcpArgv],
        agent: "claude-acp",
        agentProtocol: "acp",
        cwd: globalThis.process.cwd(),
        envBindings: [
          { name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" },
        ],
        runtimeContextMcp: { enabled: true },
      }),
      createdBy: "tiny-firegrid-simulation",
    })

    yield* session.prompt({
      payload: plannerPrompt({
        env,
        parentContextId: session.contextId,
        factoryRunKey,
        triggerFact: makeTriggerFact(env),
      }),
      idempotencyKey: `${env.runId}:planner-prompt`,
    }).pipe(
      Effect.retry(
        Schedule.intersect(
          Schedule.spaced("1000 millis"),
          Schedule.recurs(60),
        ),
      ),
    )
    yield* session.start()

    const deadline = (yield* Clock.currentTimeMillis) + 75_000
    let afterSequence: number | undefined
    let sawReady = false
    let sawPermissionRequest = false
    let sawTurnComplete = false
    let sawAgentError = false
    let agentError: string | undefined
    let sawTerminated = false
    let terminatedExitCode: number | undefined
    let resultText = ""
    const observedToolNames = new Set<string>()
    const observedFindings: Array<DarkFactoryFinding> = []

    while ((yield* Clock.currentTimeMillis) < deadline) {
      const next = yield* session.wait.forAgentOutput({
        ...(afterSequence === undefined ? {} : { afterSequence }),
        timeoutMs: 10_000,
      }).pipe(
        Effect.retry(
          Schedule.intersect(
            Schedule.spaced("1000 millis"),
            Schedule.recurs(5),
          ),
        ),
      )
      if (!next.matched) continue
      const observation: RuntimeAgentOutputObservation = next.output
      afterSequence = observation.sequence
      const event = observation.event
      switch (event._tag) {
        case "Ready":
          sawReady = true
          break
        case "PermissionRequest":
          sawPermissionRequest = true
          break
        case "ToolUse":
          observedToolNames.add(event.part.name)
          break
        case "TextChunk": {
          resultText += event.part.delta
          if (event.part.delta.includes("DARK_FACTORY_FINDING")) {
            observedFindings.push({
              id: "dark-factory.agent_reported_surface_gap",
              status: "observed",
              expectedPublicSurface:
                "Planner-reported missing public choreography surface.",
              evidence: event.part.delta.trim(),
            })
          }
          break
        }
        case "TurnComplete":
          sawTurnComplete = true
          break
        case "Error":
          sawAgentError = true
          agentError = stringifyUnknown(event.cause)
          observedFindings.push({
            id: "dark-factory.agent_error_before_choreography",
            status: "observed",
            expectedPublicSurface:
              "Planner can continue from runtime-context MCP initialization into Firegrid tool-driven choreography.",
            evidence: agentError,
          })
          break
        case "Terminated":
          sawTerminated = true
          terminatedExitCode = event.exitCode
          break
      }
      if (
        sawPermissionRequest ||
        sawTurnComplete ||
        sawAgentError ||
        sawTerminated ||
        resultText.includes("DARK_FACTORY_FINDING")
      ) break
    }

    return {
      factoryRunKey,
      plannerContextId: session.contextId,
      triggerFactInserted,
      seededFactEventTypes: ["factory.trigger.accepted"],
      fullLoopStages: [...fullLoopStages],
      sawReady,
      sawPermissionRequest,
      sawTurnComplete,
      sawAgentError,
      agentError,
      sawTerminated,
      terminatedExitCode,
      observedToolNames: [...observedToolNames].sort(),
      resultText,
      findings: [...staticChoreographyFindings, ...observedFindings],
    }
  })

export const darkFactoryPipelineSimulation = {
  id: "dark-factory-pipeline",
  description:
    "Launches a real Claude ACP planner with Firegrid runtime-context MCP, seeds an app-owned darkFactory.facts trigger, and observes the fully imagined factory-vision §6 loop without an app-authored phase chain.",
  makeHost: env =>
    tinyDarkFactoryPipeline({
      baseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
      localProcessEnv: env.localProcessEnv,
      envPolicy: darkFactoryClaudeAcpEnvPolicy(env.processEnv),
    }),
  driver: darkFactoryDriver,
  summarize: result => ({
    factoryRunKey: result.factoryRunKey,
    plannerContextId: result.plannerContextId,
    triggerFactInserted: result.triggerFactInserted,
    seededFactEventTypes: result.seededFactEventTypes,
    fullLoopStages: result.fullLoopStages,
    sawReady: result.sawReady,
    sawPermissionRequest: result.sawPermissionRequest,
    sawTurnComplete: result.sawTurnComplete,
    sawAgentError: result.sawAgentError,
    agentError: result.agentError,
    sawTerminated: result.sawTerminated,
    terminatedExitCode: result.terminatedExitCode,
    observedToolNames: result.observedToolNames,
    resultTextExcerpt: result.resultText.slice(0, 1200),
    findings: result.findings,
  }),
  localize: result => [
    "firegrid-observability.TINY_FIREGRID_SIMULATIONS.8",
    "firegrid-observability.TINY_FIREGRID_SIMULATIONS.8-1",
    "firegrid-observability.TINY_FIREGRID_SIMULATIONS.9",
    "firegrid-observability.TINY_FIREGRID_SIMULATIONS.9-1",
    `Full loop stages expressed in planner prompt: ${result.fullLoopStages.join(" -> ")}`,
    result.observedToolNames.length === 0
      ? "No planner Firegrid tool use was observed before the simulation observation window ended; inspect MCP tools/list and ACP spans in the trace artifact."
      : `Planner tool use observed: ${result.observedToolNames.join(", ")}`,
    result.sawAgentError
      ? `Agent error before choreography: ${result.agentError ?? "unknown"}`
      : "No agent Error output observed.",
    ...result.findings.map(finding =>
      `${finding.id}: ${finding.evidence}`),
  ],
} satisfies TinyFiregridSimulation<DarkFactoryPipelineSimulationResult>

/* eslint-enable local/no-fixed-polling */
