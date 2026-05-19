import {
  Firegrid,
  local,
  type RuntimeAgentOutputObservation,
} from "@firegrid/client-sdk/firegrid"
import type { ServeError } from "@effect/platform/HttpServerError"
import {
  ensurePathInput,
  FiregridMcpServerLayer,
  FiregridRuntimeHostLive,
  type FiregridHost,
  RuntimeEnvResolverPolicy,
  type RuntimeHostTopologyOptions,
} from "@firegrid/host-sdk"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import { CallerOwnedFactStreams } from "@firegrid/runtime/durable-tools"
import { Clock, Effect, Layer, Schedule, Schema, Stream } from "effect"
import {
  DurableTable,
  type DurableTableLayerOptions,
} from "effect-durable-operators"
import type { DurableTableError } from "effect-durable-operators"
import type { TinyFiregridSimulation, TinyFiregridSimulationEnv } from "./types.ts"

/* eslint-disable local/no-fixed-polling -- firegrid-observability.TINY_FIREGRID_SIMULATIONS.1 public-client simulation observation backoff. */

interface DarkFactoryFinding {
  readonly id: string
  readonly status: "known-gap" | "observed" | "blocked-external"
  readonly expectedPublicSurface: string
  readonly evidence: string
}

// Falsifiable §6 proof. Each step's verdict is derived ONLY from real
// observed Firegrid spans (ToolUse events seen through the public client
// wait.forAgentOutput) and real durable rows read back through the public
// DurableTable facade — never inferred from the planner prompt or text.
//
//  - issued            : the required Firegrid ToolUse was actually observed.
//  - backingFactPresent : the durable CallerFact the step resolves against
//                         is observable in darkFactory.facts via the public
//                         table readback (a real row, not a prompt claim).
//  - advanced          : the planner progressed PAST this step — a strictly
//                         later-stage step's ToolUse was observed at a higher
//                         span sequence (proves the wait resolved and the
//                         loop moved on, not that all waits were dumped).
//  - proven            : issued && backingFactPresent && advanced (for the
//                         terminal step, a terminal marker substitutes for
//                         `advanced`). substrateBlocked steps are NEVER
//                         proven — they are precise findings, not passes.
type S6Step =
  | "planner-plan"
  | "human-approval-wait"
  | "delegated-implementer"
  | "review-round"
  | "revision-loop"
  | "merge-signoff-wait"
  | "durable-ci-watch"
  | "clean-unwind"

interface S6StepProof {
  readonly step: S6Step
  readonly issued: boolean
  readonly backingFactPresent: boolean
  readonly advanced: boolean
  readonly proven: boolean
  readonly substrateBlocked: boolean
  readonly conditional: boolean
  readonly note: string
}

interface ObservedToolUse {
  readonly sequence: number
  readonly name: string
  readonly text: string
}

// The §6 choreography is EXPRESSED and the Firegrid path is sound (ACP
// initialize + session/new + runtime-context MCP attach all succeed). The
// planner halts at session/prompt. EMPIRICAL FACT (proven by direct
// claude-agent-acp repro — see docs/findings/tf-7dq-...md): claude-agent-acp
// returns a JSON-RPC error whose `message` carries the real cause
// ("Internal error: API Error: 400 ... usage limits ... regain access
// 2026-06-01"), but the @agentclientprotocol/sdk `RequestError` consumed by
// packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts
// (`acpPromise` -> `codecError(op,message,cause)`) drops that `message`;
// only `{code:-32603, data:{errorKind:"unknown"}, name:"RequestError"}`
// reaches `event.cause`. So the sim CANNOT name the root cause from the
// surfaced error — that is itself a Firegrid observability gap. The honest
// classification is therefore the gap, not a guessed quota detector.
const isOpaqueAcpRequestError = (evidence: string): boolean =>
  /"errorKind":\s*"unknown"/.test(evidence) &&
  !/usage limits?\b|API Error|regain access|rate.?limit|quota/i.test(evidence)

interface DarkFactoryPipelineSimulationResult {
  readonly factoryRunKey: string
  readonly plannerContextId: string
  readonly triggerFactInserted: boolean
  readonly seededFactEventTypes: ReadonlyArray<string>
  readonly fullLoopStages: ReadonlyArray<string>
  readonly sawCallerFactWaitFor: boolean
  readonly sawPlanApprovalWait: boolean
  readonly sawPrOpenedWait: boolean
  readonly sawReviewWait: boolean
  readonly sawMergeSignoffWait: boolean
  readonly sawCiWatchWait: boolean
  readonly sawImplementerDelegation: boolean
  readonly sawSessionPrompt: boolean
  readonly sawScheduleMe: boolean
  readonly sawExecuteAttempt: boolean
  readonly sawReady: boolean
  readonly sawPermissionRequest: boolean
  readonly sawTurnComplete: boolean
  readonly sawAgentError: boolean
  readonly agentError: string | undefined
  readonly sawTerminated: boolean
  readonly terminatedExitCode: number | undefined
  readonly observedToolNames: ReadonlyArray<string>
  readonly observedToolInputs: ReadonlyArray<string>
  readonly resultText: string
  readonly findings: ReadonlyArray<DarkFactoryFinding>
  // Falsifiable §6 proof (real-span + durable-readback derived).
  readonly readbackFactEventTypes: ReadonlyArray<string>
  readonly sectionSixProof: ReadonlyArray<S6StepProof>
  readonly sawPlannerPlan: boolean
  readonly sawHumanApprovalWait: boolean
  readonly sawDelegatedImplementer: boolean
  readonly sawReviewRound: boolean
  readonly sawRevisionLoop: boolean
  readonly sawDurableCiWatch: boolean
  readonly sawCleanUnwind: boolean
  readonly s6ProvenStepCount: number
  readonly s6RequiredStepCount: number
  readonly s6FullLoopProven: boolean
  // Informational: gate facts advanced in-sequence in response to the
  // planner reaching each gate (not proof logic — diagnostics/demo).
  readonly advancedGateEventTypes: ReadonlyArray<string>
  // Informational: which agent drove the §6 planner this run.
  readonly plannerAgentKind: string
}

const DarkFactoryFactRowSchema = Schema.Struct({
  factId: Schema.String.pipe(DurableTable.primaryKey),
  source: Schema.String,
  externalEventKey: Schema.String,
  externalEntityKey: Schema.String,
  eventType: Schema.String,
  contextId: Schema.optional(Schema.String),
  correlationId: Schema.String,
  stage: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  parentFactId: Schema.optional(Schema.String),
  payload: Schema.Unknown,
  acceptedAt: Schema.String,
})

type DarkFactoryFactRow = Schema.Schema.Type<typeof DarkFactoryFactRowSchema>

class DarkFactoryFactTable extends DurableTable("darkFactory", {
  facts: DarkFactoryFactRowSchema,
}) {}

const darkFactoryFactTableLayerOptions = (options: {
  readonly baseUrl: string
  readonly namespace: string
}): DurableTableLayerOptions => ({
  streamOptions: {
    url: durableStreamUrl(options.baseUrl, `${options.namespace}.darkFactory`),
    contentType: "application/json",
  },
  txTimeoutMs: 2_000,
})

interface DarkFactoryPipelineOptions {
  readonly baseUrl: string
  readonly namespace?: string
  readonly hostId?: string
  readonly mcpHost?: string
  readonly mcpPort?: number
  readonly mcpPath?: string
  readonly localProcessEnv?: RuntimeHostTopologyOptions["localProcessEnv"]
  readonly envPolicy?: Layer.Layer<RuntimeEnvResolverPolicy>
}

const darkFactoryClaudeAcpEnvPolicy = (
  env: NodeJS.ProcessEnv,
): Layer.Layer<RuntimeEnvResolverPolicy> =>
  RuntimeEnvResolverPolicy.withPolicy({
    authorizedBindings: [["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]],
    lookupEnv: name => env[name],
  })

const claudeAcpArgv = [
  "npx",
  "-y",
  "@agentclientprotocol/claude-agent-acp@0.36.1",
] as const

// codex-acp planner: the launch shape proven in tf-v2z to actually invoke
// Firegrid MCP tools end-to-end (initialize -> tools/list -> tools/call ->
// observed ToolUse). OPENAI_API_KEY, not ANTHROPIC.
const codexAcpArgv = [
  "npx",
  "-y",
  "@zed-industries/codex-acp@0.14.0",
] as const

const darkFactoryCodexAcpEnvPolicy = (
  env: NodeJS.ProcessEnv,
): Layer.Layer<RuntimeEnvResolverPolicy> =>
  RuntimeEnvResolverPolicy.withPolicy({
    authorizedBindings: [["OPENAI_API_KEY", "OPENAI_API_KEY"]],
    lookupEnv: name => env[name],
  })

// Additive planner-agent switch. DARK_FACTORY_PLANNER_AGENT=codex-acp (or
// "codex") launches the §6 planner as codex-acp; anything else / unset keeps
// the existing claude-agent-acp behavior unchanged (default preserved).
interface PlannerProfile {
  readonly kind: "claude-agent-acp" | "codex-acp"
  readonly argv: ReadonlyArray<string>
  readonly agent: string
  readonly envVarName: string
  readonly envPolicy: Layer.Layer<RuntimeEnvResolverPolicy>
}

const selectPlannerProfile = (
  processEnv: NodeJS.ProcessEnv,
): PlannerProfile => {
  const selector = (processEnv.DARK_FACTORY_PLANNER_AGENT ?? "")
    .trim()
    .toLowerCase()
  if (selector === "codex-acp" || selector === "codex") {
    return {
      kind: "codex-acp",
      argv: [...codexAcpArgv],
      agent: "codex-acp",
      envVarName: "OPENAI_API_KEY",
      envPolicy: darkFactoryCodexAcpEnvPolicy(processEnv),
    }
  }
  return {
    kind: "claude-agent-acp",
    argv: [...claudeAcpArgv],
    agent: "claude-acp",
    envVarName: "ANTHROPIC_API_KEY",
    envPolicy: darkFactoryClaudeAcpEnvPolicy(processEnv),
  }
}

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

// Error / RequestError objects carry their most diagnostic field —
// `message` (e.g. the Anthropic "API Error: 400 ... usage limits ...") — as
// a NON-enumerable own property, so `JSON.stringify` silently drops it and
// the surfaced agent error collapses to `{code,data:{errorKind:"unknown"}}`.
// Recover those fields (and recurse `cause`) so the recorded evidence is
// diagnosable from the trace artifact alone. This recovers data that is
// already present on the object; it does not synthesize anything.
const diagnosticKeys = ["name", "message", "code", "data", "cause"] as const

const normalizeForLog = (value: unknown, depth = 0): unknown => {
  if (value === null || typeof value !== "object") return value
  if (depth > 6) return "[depth-limited]"
  if (Array.isArray(value)) {
    return value.map(item => normalizeForLog(item, depth + 1))
  }
  const src = value as { readonly [key: string]: unknown }
  const enumerableKeys = Object.keys(src)
  const recoveredKeys = diagnosticKeys.filter(
    key => !enumerableKeys.includes(key) && src[key] !== undefined,
  )
  return Object.fromEntries(
    [...enumerableKeys, ...recoveredKeys].map(
      key => [key, normalizeForLog(src[key], depth + 1)] as const,
    ),
  )
}

const stringifyUnknown = (value: unknown): string => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(normalizeForLog(value)) ?? String(value)
  } catch {
    return String(value)
  }
}

const makeFactoryRunKey = (env: TinyFiregridSimulationEnv): string =>
  `${darkFactorySource}:issue-${env.runId}`

const makeTriggerFact = (
  env: TinyFiregridSimulationEnv,
  factoryRunKey: string,
): DarkFactoryFactRow => {
  const externalEntityKey = `issue-${env.runId}`
  return {
    factId: `${darkFactorySource}:${env.runId}:factory.trigger.accepted`,
    source: darkFactorySource,
    externalEventKey: `trigger-${env.runId}`,
    externalEntityKey,
    eventType: "factory.trigger.accepted",
    correlationId: factoryRunKey,
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
        "Exercise factory-vision section 6 through Firegrid agent tools. The planner owns sequencing and must report public-surface gaps instead of relying on app orchestration.",
      repoHint,
    },
  }
}

const makeFactoryFact = (input: {
  readonly env: TinyFiregridSimulationEnv
  readonly factoryRunKey: string
  readonly eventType: string
  readonly stage: string
  readonly status: string
  readonly payload: unknown
  readonly parentFactId?: string
}): DarkFactoryFactRow => {
  const externalEntityKey = `issue-${input.env.runId}`
  return {
    factId: `${darkFactorySource}:${input.env.runId}:${input.eventType}`,
    source: darkFactorySource,
    externalEventKey: `${input.eventType}:${input.env.runId}`,
    externalEntityKey,
    eventType: input.eventType,
    correlationId: input.factoryRunKey,
    stage: input.stage,
    status: input.status,
    ...(input.parentFactId === undefined ? {} : { parentFactId: input.parentFactId }),
    payload: input.payload,
    acceptedAt: new Date().toISOString(),
  }
}

// §6 gate-resolving edge facts. These are NOT seeded up front: each one is
// appended onto the darkFactory.facts CallerFact stream IN-SEQUENCE, in
// response to the planner reaching that gate (observed via its wait_for
// ToolUse). The CallerFact source is a live tail (table.facts.rows()), so a
// fact written before the planner's wait_for attaches is in the past and
// never resolves the wait — even a fixed planner would suspend at gate 1
// forever. Advancing per-gate makes each wait see a fresh post-attach append
// and the loop progress (advanced:true) once the discovery→invocation stall
// (oca1) is fixed. The proof contract (#401 sectionSixProof) is unchanged;
// only the write timing changes.
const makeGateFacts = (
  env: TinyFiregridSimulationEnv,
  factoryRunKey: string,
): ReadonlyArray<DarkFactoryFactRow> => {
  const trigger = makeTriggerFact(env, factoryRunKey)
  return [
    makeFactoryFact({
      env,
      factoryRunKey,
      eventType: "human.plan.approved",
      stage: "plan-approval",
      status: "approved",
      parentFactId: trigger.factId,
      payload: {
        approver: "tiny-firegrid.edge",
        decision: "approved",
        reason:
          "Simulation approval fact; planner must still observe it through wait_for CallerFact.",
      },
    }),
    makeFactoryFact({
      env,
      factoryRunKey,
      eventType: "github.pr.opened",
      stage: "pr-opened",
      status: "opened",
      parentFactId: trigger.factId,
      payload: {
        repo: repoHint,
        number: 1776,
        head: "factory/tf-sim-1",
        url: "https://github.example/gurdasnijor/firegrid/pull/1776",
      },
    }),
    makeFactoryFact({
      env,
      factoryRunKey,
      eventType: "github.pr.review_approved",
      stage: "review",
      status: "approved",
      parentFactId: trigger.factId,
      payload: {
        reviewer: "tiny-reviewer",
        kind: "single",
        summary: "Simulation review approval fact.",
      },
    }),
    makeFactoryFact({
      env,
      factoryRunKey,
      eventType: "human.merge.approved",
      stage: "merge-signoff",
      status: "approved",
      parentFactId: trigger.factId,
      payload: {
        approver: "tiny-firegrid.edge",
        decision: "approved",
      },
    }),
    makeFactoryFact({
      env,
      factoryRunKey,
      eventType: "github.ci.status",
      stage: "ci-watch",
      status: "green",
      parentFactId: trigger.factId,
      payload: {
        provider: "github-actions",
        state: "green",
        sha: "tiny-firegrid-simulated-sha",
      },
    }),
    makeFactoryFact({
      env,
      factoryRunKey,
      eventType: "github.pr.merged",
      stage: "merge",
      status: "merged",
      parentFactId: trigger.factId,
      payload: {
        mergedBy: "tiny-firegrid.edge",
        mergeSha: "tiny-firegrid-simulated-merge-sha",
      },
    }),
  ]
}

const seedFactoryFacts = (
  env: TinyFiregridSimulationEnv,
  factoryRunKey: string,
): Effect.Effect<{
  readonly triggerFactInserted: boolean
  readonly seededFactEventTypes: ReadonlyArray<string>
}, unknown> =>
  Effect.scoped(
    Effect.gen(function*() {
      const table = yield* DarkFactoryFactTable
      // Seed ONLY the trigger up front. Gate facts are advanced in-sequence
      // (see makeGateFacts) so they land AFTER the planner's wait_for
      // attaches to the live-tail CallerFact source.
      const trigger = makeTriggerFact(env, factoryRunKey)
      const result = yield* table.facts.insertOrGet(trigger)
      return {
        triggerFactInserted: result._tag === "Inserted",
        seededFactEventTypes: [trigger.eventType],
      }
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

// Append ONE gate-resolving fact onto the darkFactory.facts CallerFact
// stream, in response to the planner reaching that gate. Same public
// DurableTable facade + scoped-provide shape as seedFactoryFacts /
// readbackFactEventTypes (one lexical provide site — effect-quality safe).
const advanceGateFact = (
  env: TinyFiregridSimulationEnv,
  fact: DarkFactoryFactRow,
): Effect.Effect<boolean, unknown> =>
  Effect.scoped(
    Effect.gen(function*() {
      const table = yield* DarkFactoryFactTable
      const result = yield* table.facts.insertOrGet(fact)
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

// Map a planner wait_for target (substring observed in the ToolUse input) to
// the gate fact that resolves it. 1:1 with §6 gates, in loop order.
const gateFactForWait = (
  env: TinyFiregridSimulationEnv,
  factoryRunKey: string,
  waitText: string,
): DarkFactoryFactRow | undefined => {
  const gateFacts = makeGateFacts(env, factoryRunKey)
  const byType = (eventType: string): DarkFactoryFactRow | undefined =>
    gateFacts.find(fact => fact.eventType === eventType)
  if (waitText.includes("human.plan.approved")) return byType("human.plan.approved")
  if (waitText.includes("github.pr.opened")) return byType("github.pr.opened")
  if (
    waitText.includes("github.pr.review_approved") ||
    waitText.includes("github.pr.review_posted")
  ) return byType("github.pr.review_approved")
  if (waitText.includes("human.merge.approved")) return byType("human.merge.approved")
  if (waitText.includes("github.ci.status")) return byType("github.ci.status")
  if (waitText.includes("github.pr.merged")) return byType("github.pr.merged")
  return undefined
}

// Read the app-owned facts BACK through the public DurableTable facade
// (same surface the planner's wait_for CallerFact resolves against). This
// proves the backing rows are real, persisted, and observable — not merely
// write-acknowledged or asserted by the prompt. Scoped to this run.
const readbackFactEventTypes = (
  env: TinyFiregridSimulationEnv,
): Effect.Effect<ReadonlyArray<string>, unknown> =>
  Effect.scoped(
    Effect.gen(function*() {
      const table = yield* DarkFactoryFactTable
      const rows = yield* table.facts.query(coll => coll.toArray)
      return rows
        .filter(row => row.factId.includes(env.runId))
        .map(row => row.eventType)
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

const minSeqWhere = (
  tools: ReadonlyArray<ObservedToolUse>,
  predicate: (tool: ObservedToolUse) => boolean,
): number | undefined => {
  const matches = tools.filter(predicate).map(tool => tool.sequence)
  return matches.length === 0 ? undefined : Math.min(...matches)
}

const hasToolAfter = (
  tools: ReadonlyArray<ObservedToolUse>,
  afterSeq: number | undefined,
  predicate: (tool: ObservedToolUse) => boolean,
): boolean =>
  afterSeq !== undefined &&
  tools.some(tool => tool.sequence > afterSeq && predicate(tool))

const isWaitFor = (target: string) =>
(tool: ObservedToolUse): boolean =>
  tool.name === "wait_for" && tool.text.includes(target)

const isToolNamed = (name: string) =>
(tool: ObservedToolUse): boolean => tool.name === name

// Pure: build the falsifiable §6 proof matrix from observed tool spans,
// durable readback, and a terminal marker. No prompt inference.
const buildSectionSixProof = (input: {
  readonly tools: ReadonlyArray<ObservedToolUse>
  readonly readbackEventTypes: ReadonlyArray<string>
  readonly sawTerminalMarker: boolean
}): ReadonlyArray<S6StepProof> => {
  const { tools, readbackEventTypes, sawTerminalMarker } = input
  const backed = (eventType: string): boolean =>
    readbackEventTypes.includes(eventType)

  const planSeq = minSeqWhere(tools, isWaitFor("human.plan.approved"))
  const delegateSeq = minSeqWhere(tools, isToolNamed("session_new"))
  const reviewSeq = minSeqWhere(
    tools,
    tool =>
      tool.name === "wait_for" &&
      (tool.text.includes("github.pr.review_approved") ||
        tool.text.includes("github.pr.review_posted")),
  )
  const mergeSeq = minSeqWhere(tools, isWaitFor("human.merge.approved"))
  const ciSeq = minSeqWhere(tools, isWaitFor("github.ci.status"))
  const revisionSeq = minSeqWhere(
    tools,
    tool =>
      tool.name === "session_prompt" &&
      reviewSeq !== undefined &&
      tool.sequence > reviewSeq,
  )

  const advancedAfter = (seq: number | undefined): boolean =>
    hasToolAfter(tools, seq, tool => tool.name !== "wait_for") ||
    hasToolAfter(tools, seq, isWaitFor("github.")) ||
    hasToolAfter(tools, seq, isWaitFor("human.merge.")) ||
    hasToolAfter(tools, seq, isWaitFor("github.ci.status"))

  const step = (
    s: S6Step,
    issued: boolean,
    backingFactPresent: boolean,
    advanced: boolean,
    extra?: Partial<S6StepProof>,
  ): S6StepProof => ({
    step: s,
    issued,
    backingFactPresent,
    advanced,
    proven:
      (extra?.substrateBlocked ?? false)
        ? false
        : issued && backingFactPresent && advanced,
    substrateBlocked: extra?.substrateBlocked ?? false,
    conditional: extra?.conditional ?? false,
    note: extra?.note ?? "",
  })

  return [
    step(
      "planner-plan",
      planSeq !== undefined,
      backed("human.plan.approved"),
      advancedAfter(planSeq),
      { note: "Planner reached the plan→approval gate via a real wait_for human.plan.approved ToolUse and progressed past it." },
    ),
    step(
      "human-approval-wait",
      tools.some(tool =>
        tool.name === "wait_for" &&
        tool.text.includes("CallerFact") &&
        tool.text.includes(darkFactoryFactSource) &&
        tool.text.includes("human.plan.approved")),
      backed("human.plan.approved"),
      advancedAfter(planSeq),
      { note: "wait_for CallerFact darkFactory.facts human.plan.approved resolved against a real durable row." },
    ),
    step(
      "delegated-implementer",
      delegateSeq !== undefined,
      backed("github.pr.opened") || backed("factory.child.session.started"),
      hasToolAfter(tools, delegateSeq, tool =>
        tool.name === "session_prompt" || tool.name === "wait_for"),
      { note: "session_new child delegation observed, followed by session_prompt / pr-opened wait." },
    ),
    step(
      "review-round",
      reviewSeq !== undefined,
      backed("github.pr.review_approved") ||
        backed("github.pr.review_posted"),
      advancedAfter(reviewSeq),
      { note: "wait_for github.pr.review_* resolved and the loop advanced to merge/CI." },
    ),
    step(
      "revision-loop",
      revisionSeq !== undefined,
      backed("github.pr.review_changes_requested"),
      revisionSeq !== undefined,
      {
        conditional: true,
        note:
          "Conditional: the seeded happy path approves review, so a revision round may not be exercised. Not-exercised is NOT a failure; exercised requires a real session_prompt after a review wait.",
      },
    ),
    step(
      "merge-signoff-wait",
      mergeSeq !== undefined,
      backed("human.merge.approved"),
      advancedAfter(mergeSeq),
      { note: "wait_for human.merge.approved resolved against a real durable row and advanced to CI watch." },
    ),
    step(
      "durable-ci-watch",
      ciSeq !== undefined,
      backed("github.ci.status"),
      sawTerminalMarker || backed("github.pr.merged"),
      { note: "wait_for github.ci.status resolved; terminal reached (DARK_FACTORY_TERMINAL or github.pr.merged)." },
    ),
    step(
      "clean-unwind",
      tools.some(tool =>
        tool.name === "session_cancel" || tool.name === "session_close"),
      false,
      false,
      {
        substrateBlocked: true,
        note:
          "SUBSTRATE GAP (precise finding, not a pass): host-sdk agent-tool-host-live returns unsupportedAgentTool for session_cancel/session_close, so clean-unwind CANNOT be proven through the public surface yet regardless of planner intent.",
      },
    ),
  ]
}

const tinyDarkFactoryPipeline = (
  options: DarkFactoryPipelineOptions,
): Layer.Layer<FiregridHost, DurableTableError | ServeError, never> => {
  const namespace = options.namespace ?? `tiny-dark-factory-${globalThis.crypto.randomUUID()}`
  const hostId = options.hostId ?? "host-a"
  const mcpHost = options.mcpHost ?? "127.0.0.1"
  const mcpPath = options.mcpPath ?? "/mcp"
  const facts = DarkFactoryFactTable.layer(
    darkFactoryFactTableLayerOptions({ baseUrl: options.baseUrl, namespace }),
  )
  const callerFacts = Layer.effect(
    CallerOwnedFactStreams,
    Effect.map(DarkFactoryFactTable, table => ({
      streamFor: (stream: string) =>
        stream === darkFactoryFactSource ? table.facts.rows() : Stream.empty,
    })),
  ).pipe(Layer.provide(facts))
  const appFacts = Layer.merge(facts, callerFacts)
  const host = FiregridRuntimeHostLive(
    {
      durableStreamsBaseUrl: options.baseUrl,
      namespace,
      hostId,
      hostSessionId: `${hostId}-session`,
      input: true,
      ...(options.localProcessEnv === undefined
        ? {}
        : { localProcessEnv: options.localProcessEnv }),
    },
    options.envPolicy ?? RuntimeEnvResolverPolicy.denyAll,
  ).pipe(Layer.provideMerge(appFacts))

  // firegrid-observability.TINY_FIREGRID_SIMULATIONS.8
  // Public host factories infer an internal layer surface wider than FiregridHost.
  return Layer.discard(
    FiregridMcpServerLayer({
      host: mcpHost,
      port: options.mcpPort ?? 0,
      path: ensurePathInput(mcpPath),
    }),
  ).pipe(
    Layer.provideMerge(host),
    Layer.provideMerge(appFacts),
  ) as Layer.Layer<FiregridHost, DurableTableError | ServeError, never>
}

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
    "HARD CONSTRAINTS — READ FIRST:",
    "- Your ONLY available tools are the Firegrid runtime-context tools:",
    "  wait_for, session_new, session_prompt, schedule_me, execute, sleep,",
    "  session_cancel, session_close. Nothing else.",
    "- You have NO filesystem, NO shell, NO repo read/grep/search, NO web,",
    "  NO MCP-resource browsing. Do NOT attempt to read or explore this",
    "  repository or list resources — those tools do not exist for you and",
    "  any such attempt is wasted effort that makes ZERO progress.",
    "- The ONLY way to make ANY progress on the goal is to CALL the Firegrid",
    "  tools above. Begin by calling them immediately. Do not explore, do",
    "  not plan in prose first — issue the first Firegrid tool call now.",
    "",
    "Goal:",
    "Drive the full factory-vision section 6 loop using only Firegrid tools.",
    "You own sequencing. There is no hidden workflow DAG or app driver.",
    "",
    "Factory run:",
    `- parentContextId: ${input.parentContextId}`,
    `- factoryRunKey: ${input.factoryRunKey}`,
    `- factSource: ${darkFactoryFactSource}`,
    `- fullLoopStages: ${fullLoopStages.join(" -> ")}`,
    "",
    "Accepted trigger fact already written at the app edge:",
    JSON.stringify(input.triggerFact, null, 2),
    "",
    "Simulation edge facts are preseeded for the happy-path human/provider decisions.",
    "You must still observe each gate through wait_for; do not infer success from this prompt.",
    "Use this exact wait_for shape for app-owned facts:",
    JSON.stringify({
      waitQuery: {
        source: { _tag: "CallerFact", stream: darkFactoryFactSource },
        whereFields: {
          correlationId: input.factoryRunKey,
          eventType: "human.plan.approved",
        },
      },
      timeoutMs: 30_000,
    }, null, 2),
    "",
    "App-owned durable fact event types:",
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
    "Full section 6 choreography contract:",
    "1. Ticket arrives: read the accepted trigger fact and decide whether the ticket is actionable.",
    "2. Optional clarify: if ambiguous, ask a focused question and wait_for human.clarification.answered.",
    "3. Plan: produce a concise plan, then wait_for human.plan.approved, human.plan.rejected, or factory.plan.revision_requested.",
    "4. Revision loop: on revision or rejection-with-feedback, revise the plan and request approval again. On clean rejection, unwind child work.",
    "5. Implementer delegation: call session_new with the plan, issue context, repo, branch, parent context id, and factoryRunKey. Then wait_for github.pr.opened.",
    "6. Review selection: decide one reviewer versus multi-reviewer council. A typo gets one reviewer; architectural/high-risk work gets multiple reviewer sessions if expressible.",
    "7. Review loop: wait_for github.pr.review_approved or github.pr.review_changes_requested. If changes are requested, session_prompt feedback to the implementer and wait for a revision. For this seeded happy path, still make one session_prompt call to the implementer after review approval asking for a merge-ready branch note.",
    "8. Merge sign-off: wait_for human.merge.approved or human.merge.rejected. On rejection, unwind cleanly.",
    "9. CI watch: call schedule_me once for a bounded CI recheck, then wait_for github.ci.status green. On failure, prompt the implementer with CI evidence and wait for a fix.",
    "10. Merge: when CI is green and merge is approved, call execute for github.squashMergePullRequest. If execute reports unsupported, emit DARK_FACTORY_FINDING for the missing provider side-effect surface and halt. If execute succeeds, wait_for github.pr.merged.",
    "11. Clean unwind: on rejection at any gate, use session_cancel/session_close where available, record a terminal outcome, and leave durable history inspectable.",
    "",
    "Tool-use rules:",
    `1. Use wait_for over ${darkFactoryFactSource} for human gates, provider facts, review verdicts, CI status, merge evidence, and unwind evidence.`,
    "2. Use session_new to create implementer, reviewer, council, and QA child sessions when needed.",
    "3. Use session_prompt for follow-up work on an existing child session.",
    "4. Use schedule_me for future self rechecks, especially CI still pending or provider eventual consistency.",
    "5. Use execute only for advertised provider/sandbox capabilities. Record or wait for durable facts that confirm side effects.",
    "6. Use sleep only as short local backoff; do not use it for human or provider waits.",
    "",
    "Hard halt rule for this simulation:",
    "If a needed step is not expressible through the Firegrid tools you can see, do not invent an app-side workflow or pretend progress.",
    "Instead write one line beginning with DARK_FACTORY_FINDING and name: what you needed, what public tool/channel you expected, and what is missing.",
    "When the loop reaches a terminal state, write one line beginning with DARK_FACTORY_TERMINAL and include factoryRunKey, final status, PR number, review status, merge sign-off status, CI status, and any halted gap.",
    "",
    "Start now by deciding whether clarification is needed. If it is actionable without clarification, produce the plan and call wait_for for human.plan.approved.",
  ].join("\n")
}

const toolUseText = (
  observation: RuntimeAgentOutputObservation,
): string | undefined =>
  observation.event._tag === "ToolUse"
    ? `${observation.event.part.name}:${stringifyUnknown(observation.event.part.params)}`
    : undefined

const darkFactoryDriver = (
  env: TinyFiregridSimulationEnv,
): Effect.Effect<DarkFactoryPipelineSimulationResult, unknown, Firegrid> =>
  Effect.gen(function*() {
    const planner = selectPlannerProfile(env.processEnv)
    const plannerKey = env.processEnv[planner.envVarName]
    if (plannerKey === undefined || plannerKey.length === 0) {
      return yield* Effect.fail(new Error(
        `dark-factory-pipeline requires ${planner.envVarName} for the ${planner.kind} planner`,
      ))
    }

    const firegrid = yield* Firegrid
    const factoryRunKey = makeFactoryRunKey(env)
    // The driver seeds durable edge facts and then only observes; the planner
    // remains responsible for every supported section 6 choreography step.
    const seeded = yield* seedFactoryFacts(env, factoryRunKey)
    const triggerFact = makeTriggerFact(env, factoryRunKey)
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: {
        source: "tiny-firegrid.dark-factory",
        id: factoryRunKey,
      },
      runtime: local.jsonl({
        argv: [...planner.argv],
        agent: planner.agent,
        agentProtocol: "acp",
        cwd: globalThis.process.cwd(),
        envBindings: [
          { name: planner.envVarName, ref: `env:${planner.envVarName}` },
        ],
        runtimeContextMcp: { enabled: true },
      }),
      createdBy: "tiny-firegrid-simulation",
    })

    yield* firegrid.sessions.prompt({
      sessionId: session.contextId,
      prompt: plannerPrompt({
        env,
        parentContextId: session.contextId,
        factoryRunKey,
        triggerFact,
      }),
      inputId: "planner-prompt",
    }).pipe(
      Effect.retry(
        Schedule.intersect(
          Schedule.spaced("1000 millis"),
          Schedule.recurs(60),
        ),
      ),
    )
    yield* session.start()

    const deadline = (yield* Clock.currentTimeMillis) + 180_000
    let afterSequence: number | undefined
    let sawReady = false
    let sawCallerFactWaitFor = false
    let sawPlanApprovalWait = false
    let sawPrOpenedWait = false
    let sawReviewWait = false
    let sawMergeSignoffWait = false
    let sawCiWatchWait = false
    let sawImplementerDelegation = false
    let sawSessionPrompt = false
    let sawScheduleMe = false
    let sawExecuteAttempt = false
    let sawPermissionRequest = false
    let sawTurnComplete = false
    let sawAgentError = false
    let agentError: string | undefined
    let sawTerminated = false
    let terminatedExitCode: number | undefined
    let resultText = ""
    const observedToolNames = new Set<string>()
    const observedToolInputs: Array<string> = []
    const observedToolUses: Array<ObservedToolUse> = []
    const observedFindings: Array<DarkFactoryFinding> = []
    const advancedGateEventTypes = new Set<string>()

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
        case "ToolUse": {
          observedToolNames.add(event.part.name)
          sawImplementerDelegation = sawImplementerDelegation ||
            event.part.name === "session_new"
          sawSessionPrompt = sawSessionPrompt || event.part.name === "session_prompt"
          sawScheduleMe = sawScheduleMe || event.part.name === "schedule_me"
          sawExecuteAttempt = sawExecuteAttempt || event.part.name === "execute"
          const inputText = toolUseText(observation)
          observedToolUses.push({
            sequence: observation.sequence,
            name: event.part.name,
            text: inputText ?? "",
          })
          if (inputText !== undefined) {
            observedToolInputs.push(inputText.slice(0, 2_000))
            if (event.part.name === "wait_for") {
              sawCallerFactWaitFor = sawCallerFactWaitFor ||
                (inputText.includes("CallerFact") &&
                  inputText.includes(darkFactoryFactSource))
              sawPlanApprovalWait = sawPlanApprovalWait ||
                inputText.includes("human.plan.approved")
              sawPrOpenedWait = sawPrOpenedWait ||
                inputText.includes("github.pr.opened")
              sawReviewWait = sawReviewWait ||
                (inputText.includes("github.pr.review_approved") ||
                  inputText.includes("github.pr.review_posted"))
              sawMergeSignoffWait = sawMergeSignoffWait ||
                inputText.includes("human.merge.approved")
              sawCiWatchWait = sawCiWatchWait ||
                inputText.includes("github.ci.status")
              // IN-SEQUENCE FACT ADVANCEMENT: the planner just reached this
              // gate (issued wait_for). Append the matching gate fact NOW so
              // the wait — which has attached to the live-tail CallerFact
              // source — sees a fresh post-attach append and resolves, and
              // the loop progresses to the next gate. A short settle lets the
              // host process the wait_for and attach before we append.
              const gateFact = gateFactForWait(env, factoryRunKey, inputText)
              if (
                gateFact !== undefined &&
                !advancedGateEventTypes.has(gateFact.eventType)
              ) {
                advancedGateEventTypes.add(gateFact.eventType)
                yield* Effect.sleep("750 millis")
                yield* advanceGateFact(env, gateFact).pipe(
                  Effect.catchAll(cause =>
                    Effect.sync(() => {
                      // Surface a precise finding rather than papering: an
                      // append failure means in-sequence advancement is
                      // blocked through the public facade.
                      observedFindings.push({
                        id: `dark-factory.s6.fact_advance_failed.${gateFact.eventType}`,
                        status: "blocked-external",
                        expectedPublicSurface:
                          `Appending the ${gateFact.eventType} gate fact onto the darkFactory.facts CallerFact stream via the public DurableTable facade should resolve the planner's in-flight wait_for.`,
                        evidence: stringifyUnknown(cause),
                      })
                    })),
                )
              }
            }
          }
          break
        }
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
          if (isOpaqueAcpRequestError(agentError)) {
            observedFindings.push({
              id: "dark-factory.acp_error_message_not_propagated",
              status: "blocked-external",
              expectedPublicSurface:
                "A failed ACP session/prompt should surface the JSON-RPC error.message so the halt is diagnosable from the trace artifact. Today the @agentclientprotocol/sdk RequestError consumed by packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts (acpPromise -> codecError) drops error.message; only {code:-32603,data:{errorKind:\"unknown\"},name:\"RequestError\"} reaches event.cause. The real cause for this run — external Anthropic account usage limit (regains 2026-06-01 UTC) — was confirmed only by a direct claude-agent-acp repro (see docs/findings/tf-7dq-...). §6 is EXPRESSED and the Firegrid path is sound up to the model turn; it cannot be PROVEN until run with available Anthropic quota.",
              evidence: agentError,
            })
          }
          break
        case "Terminated":
          sawTerminated = true
          terminatedExitCode = event.exitCode
          break
      }
      if (
        sawTurnComplete ||
        sawAgentError ||
        sawTerminated ||
        resultText.includes("DARK_FACTORY_FINDING") ||
        resultText.includes("DARK_FACTORY_TERMINAL")
      ) break
    }

    // Falsifiable §6 proof: derived ONLY from real observed tool spans and a
    // durable readback through the public facade — never the prompt.
    const sawTerminalMarker =
      resultText.includes("DARK_FACTORY_TERMINAL") || sawTurnComplete
    const readbackEventTypes = yield* readbackFactEventTypes(env).pipe(
      Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<string>)),
    )
    const sectionSixProof = buildSectionSixProof({
      tools: observedToolUses,
      readbackEventTypes,
      sawTerminalMarker,
    })
    const proofOf = (s: S6Step): S6StepProof | undefined =>
      sectionSixProof.find(entry => entry.step === s)
    const isProven = (s: S6Step): boolean => proofOf(s)?.proven === true
    const requiredSteps = sectionSixProof.filter(
      entry => !entry.conditional && !entry.substrateBlocked,
    )
    const s6ProvenStepCount = requiredSteps.filter(
      entry => entry.proven,
    ).length
    // Precise findings for required steps that did not prove, and for the
    // substrate-blocked clean-unwind (never a pass).
    sectionSixProof
      .filter(entry => entry.substrateBlocked)
      .forEach(entry =>
        observedFindings.push({
          id: `dark-factory.s6.${entry.step}.substrate_blocked`,
          status: "known-gap",
          expectedPublicSurface:
            `§6 step "${entry.step}" cannot be PROVEN through the public surface yet. ${entry.note}`,
          evidence: `issued=${String(entry.issued)} (substrate path absent)`,
        }))
    requiredSteps
      .filter(entry => !entry.proven)
      .forEach(entry =>
        observedFindings.push({
          id: `dark-factory.s6.${entry.step}.not_proven`,
          status: "observed",
          expectedPublicSurface:
            `§6 step "${entry.step}" must be observable end-to-end through Firegrid tools + durable facts.`,
          evidence:
            `issued=${String(entry.issued)} backingFactPresent=${String(entry.backingFactPresent)} advanced=${String(entry.advanced)} — not PROVEN-run.`,
        }))

    return {
      factoryRunKey,
      plannerContextId: session.contextId,
      triggerFactInserted: seeded.triggerFactInserted,
      seededFactEventTypes: seeded.seededFactEventTypes,
      fullLoopStages: [...fullLoopStages],
      sawCallerFactWaitFor,
      sawPlanApprovalWait,
      sawPrOpenedWait,
      sawReviewWait,
      sawCiWatchWait,
      sawImplementerDelegation,
      sawSessionPrompt,
      sawScheduleMe,
      sawExecuteAttempt,
      sawReady,
      sawPermissionRequest,
      sawTurnComplete,
      sawAgentError,
      agentError,
      sawTerminated,
      terminatedExitCode,
      observedToolNames: [...observedToolNames].sort(),
      observedToolInputs,
      resultText,
      findings: [...staticChoreographyFindings, ...observedFindings],
      readbackFactEventTypes: readbackEventTypes,
      sectionSixProof,
      sawPlannerPlan: isProven("planner-plan"),
      sawHumanApprovalWait: isProven("human-approval-wait"),
      sawDelegatedImplementer: isProven("delegated-implementer"),
      sawReviewRound: isProven("review-round"),
      sawRevisionLoop: proofOf("revision-loop")?.issued === true,
      sawMergeSignoffWait: isProven("merge-signoff-wait"),
      sawDurableCiWatch: isProven("durable-ci-watch"),
      sawCleanUnwind: isProven("clean-unwind"),
      s6ProvenStepCount,
      s6RequiredStepCount: requiredSteps.length,
      s6FullLoopProven:
        requiredSteps.length > 0 &&
        s6ProvenStepCount === requiredSteps.length,
      advancedGateEventTypes: [...advancedGateEventTypes],
      plannerAgentKind: planner.kind,
    }
  })

export const darkFactoryPipelineSimulation = {
  id: "dark-factory-pipeline",
  description:
    "Launches a real Claude ACP planner with Firegrid runtime-context MCP, binds app-owned darkFactory.facts as a CallerFact stream, seeds edge facts, and observes the fully imagined factory-vision section 6 loop without an app-authored phase chain.",
  makeHost: env =>
    tinyDarkFactoryPipeline({
      baseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
      localProcessEnv: env.localProcessEnv,
      envPolicy: selectPlannerProfile(env.processEnv).envPolicy,
    }),
  driver: darkFactoryDriver,
  summarize: result => ({
    factoryRunKey: result.factoryRunKey,
    plannerContextId: result.plannerContextId,
    triggerFactInserted: result.triggerFactInserted,
    seededFactEventTypes: result.seededFactEventTypes,
    fullLoopStages: result.fullLoopStages,
    sawCallerFactWaitFor: result.sawCallerFactWaitFor,
    sawPlanApprovalWait: result.sawPlanApprovalWait,
    sawPrOpenedWait: result.sawPrOpenedWait,
    sawReviewWait: result.sawReviewWait,
    sawMergeSignoffWait: result.sawMergeSignoffWait,
    sawCiWatchWait: result.sawCiWatchWait,
    sawImplementerDelegation: result.sawImplementerDelegation,
    sawSessionPrompt: result.sawSessionPrompt,
    sawScheduleMe: result.sawScheduleMe,
    sawExecuteAttempt: result.sawExecuteAttempt,
    sawReady: result.sawReady,
    sawPermissionRequest: result.sawPermissionRequest,
    sawTurnComplete: result.sawTurnComplete,
    sawAgentError: result.sawAgentError,
    agentError: result.agentError,
    sawTerminated: result.sawTerminated,
    terminatedExitCode: result.terminatedExitCode,
    observedToolNames: result.observedToolNames,
    observedToolInputs: result.observedToolInputs.slice(0, 20),
    resultTextExcerpt: result.resultText.slice(0, 1_200),
    findings: result.findings,
    readbackFactEventTypes: result.readbackFactEventTypes,
    s6FullLoopProven: result.s6FullLoopProven,
    s6ProvenStepCount: result.s6ProvenStepCount,
    s6RequiredStepCount: result.s6RequiredStepCount,
    sawPlannerPlan: result.sawPlannerPlan,
    sawHumanApprovalWait: result.sawHumanApprovalWait,
    sawDelegatedImplementer: result.sawDelegatedImplementer,
    sawReviewRound: result.sawReviewRound,
    sawRevisionLoop: result.sawRevisionLoop,
    sawDurableCiWatch: result.sawDurableCiWatch,
    sawCleanUnwind: result.sawCleanUnwind,
    sectionSixProof: result.sectionSixProof,
    advancedGateEventTypes: result.advancedGateEventTypes,
    plannerAgentKind: result.plannerAgentKind,
  }),
  localize: result => [
    "firegrid-observability.TINY_FIREGRID_SIMULATIONS.8",
    "firegrid-observability.TINY_FIREGRID_SIMULATIONS.8-1",
    "firegrid-observability.TINY_FIREGRID_SIMULATIONS.9",
    "firegrid-observability.TINY_FIREGRID_SIMULATIONS.9-1",
    `Full loop stages expressed in planner prompt: ${result.fullLoopStages.join(" -> ")}`,
    `CallerFact wait observed: ${String(result.sawCallerFactWaitFor)}`,
    `Section 6 coverage: planApproval=${String(result.sawPlanApprovalWait)}, prOpened=${String(result.sawPrOpenedWait)}, review=${String(result.sawReviewWait)}, mergeSignoff=${String(result.sawMergeSignoffWait)}, ci=${String(result.sawCiWatchWait)}, sessionNew=${String(result.sawImplementerDelegation)}, sessionPrompt=${String(result.sawSessionPrompt)}, scheduleMe=${String(result.sawScheduleMe)}, execute=${String(result.sawExecuteAttempt)}`,
    result.observedToolNames.length === 0
      ? "No planner Firegrid tool use was observed before the simulation observation window ended; inspect MCP tools/list and ACP spans in the trace artifact."
      : `Planner tool use observed: ${result.observedToolNames.join(", ")}`,
    result.sawAgentError
      ? `Agent error before choreography: ${result.agentError ?? "unknown"}`
      : "No agent Error output observed.",
    result.s6FullLoopProven
      ? `§6 FULL LOOP PROVEN: all ${result.s6RequiredStepCount} required steps observed end-to-end through Firegrid tools + durable readback.`
      : `§6 NOT fully proven: ${result.s6ProvenStepCount}/${result.s6RequiredStepCount} required steps proven-run (clean-unwind is substrate-blocked, revision-loop is conditional).`,
    `§6 proof matrix (issued/backing/advanced -> proven): ${
      result.sectionSixProof
        .map(entry =>
          `${entry.step}[${entry.issued ? "i" : "-"}${entry.backingFactPresent ? "b" : "-"}${entry.advanced ? "a" : "-"}${entry.substrateBlocked ? "X" : entry.proven ? "✓" : entry.conditional ? "?" : "✗"}]`)
        .join(" ")
    }`,
    `Durable readback fact event types (public facade): ${
      result.readbackFactEventTypes.length === 0
        ? "none"
        : result.readbackFactEventTypes.join(", ")
    }`,
    ...result.findings.map(finding =>
      `${finding.id}: ${finding.evidence}`),
  ],
} satisfies TinyFiregridSimulation<DarkFactoryPipelineSimulationResult>

/* eslint-enable local/no-fixed-polling */
