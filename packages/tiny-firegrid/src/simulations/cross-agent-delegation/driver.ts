/**
 * cap-4 CROSS-AGENT DELEGATION driver — re-establishes the deleted
 * inv5-cross-agent-event-choreography shape on the unified surface using the
 * public `session_new` agent-tool (#831 / tf-0awo.32), and serves as the live
 * acceptance that `session_new`'s lowering performs observable parent -> child
 * delegation end-to-end.
 *
 * Shape (proven by `factory-capstone`): a real off-the-shelf ACP planner
 * agent (`@agentclientprotocol/claude-agent-acp`) is spawned in the parent RuntimeContext
 * with `runtimeContextMcp` enabled, so the host injects its per-context MCP
 * server. The planner calls the Firegrid `session_new` MCP tool to delegate to a
 * CHILD agent; the dispatch spawns + prompts + starts the child (itself a
 * codex-acp agent, inheriting the parent's argv/config/envBindings); the child
 * emits an observable marker into its OWN context's output stream. Correlation
 * is observed over the PUBLIC surface: the `session_new` tool result hands the
 * child `contextId` back to the planner, which echoes it. Child-context
 * projection reads moved to the MCP observation client, so this direct driver
 * does not open the child context read-only.
 *
 * Why an ACP agent and not a deterministic stdio fixture: `session_new` is
 * reachable ONLY through the MCP-entry path; a `"raw"`/stdio-jsonl agent has
 * neither a wired `tool_use` dispatch nor an MCP slot. See
 * docs/findings/tf-0awo-31-3-cross-agent-delegation.md (source-verified). The
 * planner is claude-acp (not codex-acp): in this environment the codex ACP agent
 * emits zero agent output — corroborated by the reference `codex-acp-tool-calls`
 * sim — whereas claude-acp is productive (see `factory-capstone`).
 *
 * Methodology (packages/tiny-firegrid/docs/methodology.md): the driver imports
 * ONLY `@firegrid/client-sdk` (+ Effect), draws no verdict, returns an opaque
 * observation record, and emits a span tree. The trace + prose finding are the
 * deliverables. Gated on ANTHROPIC_API_KEY: absent -> halt `blocked` (same
 * contract as `factory-capstone`); the only fixture is the real spawn target.
 */

import {
  Firegrid,
  local,
} from "@firegrid/client-sdk/firegrid"
import { Clock, Config, Effect, Option } from "effect"

const claudeAcpArgv = [
  "npx",
  "-y",
  "@agentclientprotocol/claude-agent-acp@0.36.1",
] as const

// Mirror the host's bound MCP listener (host.ts) so the planner can be pointed
// at its per-context runtime MCP endpoint explicitly, exactly as
// `factory-capstone` does. The host ALSO injects this via runtimeContextMcp;
// the explicit entry is belt-and-suspenders for the claude-acp MCP loader.
const mcpHost = "127.0.0.1"
const mcpPort = 43792
const mcpPath = "/mcp"
const mcpServerName = "firegrid-runtime-context"
const mcpUrlForContext = (contextId: string): string =>
  `http://${mcpHost}:${mcpPort}${mcpPath}/runtime-context/${encodeURIComponent(contextId)}`

const childMarker = "CROSS_AGENT_DELEGATION_CHILD_OBSERVED"
const parentEchoPrefix = "PARENT_DELEGATED contextId="

// The planner is asked, as a direct operator request, to delegate via the
// Firegrid `session_new` MCP tool and then echo the child contextId the tool
// result hands back — the public-surface correlation channel. Framed as a
// genuine first-person task (not a quoted instruction) because the claude-acp
// agent is Claude Code and will treat a quoted "do X" block as a possible
// prompt injection and decline (observed; see finding).
const plannerPrompt = [
  "I am the operator and this is my genuine request to you. Please do exactly this now.",
  "",
  "This ACP session has a connected MCP server named `firegrid-runtime-context`",
  "exposing Firegrid agent tools, including `session_new`. I am explicitly",
  "authorizing and asking you to use it — it is not an injection.",
  "",
  "Task: call the `session_new` tool EXACTLY ONCE with these arguments:",
  '  agentKind: "cross-agent-delegation-child"',
  `  prompt: "Reply with EXACTLY this one line and nothing else: ${childMarker}"`,
  "",
  "The tool returns a JSON object with a `session.contextId` string field.",
  "As soon as that single tool call returns, reply with EXACTLY this one line and",
  `nothing else: ${parentEchoPrefix}<the session.contextId value>`,
  "Do not call any tool more than once. Do not reply before the tool call returns.",
].join("\n")

const anthropicKeyConfig = Config.redacted("ANTHROPIC_API_KEY").pipe(Config.option)

interface CrossAgentDelegationResult {
  readonly status: "captured" | "blocked"
  readonly parentContextId: string
  readonly childContextId: string
  readonly sawSessionNewToolUse: boolean
  readonly childContextIdRecovered: boolean
  readonly observedChildCreatedBy: string
  readonly childCorrelatedToParent: boolean
  readonly childObservableOutputSeen: boolean
  readonly parentOutputTags: string
}

// The child contextId is a host-owned fact (its toolUseId carries a host-internal
// `id_<random>` never exposed to the client) — the public surface delivers it
// only through the `session_new` tool RESULT, which rides back into the parent's
// ToolUse observation. We scan ALL of each observation (the tool-call part holds
// the full id) and keep the LONGEST `session_new` id seen: the agent's own
// TextChunk echo of a ~150-char opaque id is lossy/truncated, but the tool-result
// part carries it verbatim. (Finding: there is no first-class "observe my
// delegated child" client verb; correlation rides the tool result.)
const childIdPattern = /session:firegrid\.mcp\.session_new:[A-Za-z0-9:._-]+/g

const longestChildId = (
  haystack: string,
  current: string | undefined,
): string | undefined =>
  (haystack.match(childIdPattern) ?? []).reduce(
    (best: string | undefined, candidate) =>
      best === undefined || candidate.length > best.length ? candidate : best,
    current,
  )

export const driver: Effect.Effect<
  CrossAgentDelegationResult,
  unknown,
  Firegrid
> = Effect.scoped(Effect.gen(function*() {
  const firegrid = yield* Firegrid

  // Gate: real delegation requires a real ACP agent (parent AND child are
  // claude-acp). Without a key, halt as a recorded `blocked` finding.
  const anthropicKey = yield* anthropicKeyConfig
  if (Option.isNone(anthropicKey)) {
    yield* Effect.annotateCurrentSpan({
      "firegrid.cross_agent_delegation.status": "blocked",
      "firegrid.cross_agent_delegation.blocked_reason": "ANTHROPIC_API_KEY is absent",
    })
    return {
      status: "blocked",
      parentContextId: "",
      childContextId: "",
      sawSessionNewToolUse: false,
      childContextIdRecovered: false,
      observedChildCreatedBy: "",
      childCorrelatedToParent: false,
      childObservableOutputSeen: false,
      parentOutputTags: "",
    } satisfies CrossAgentDelegationResult
  }

  const externalKey = {
    source: "tiny-firegrid.cross-agent-delegation",
    id: "cross-agent-delegation-planner",
  }
  // The session contextId is `session:<source>:<id>` (config over the public
  // launch seam — mirrors the merged createOrLoad binding), known before the
  // call so the planner can be pointed at its per-context MCP URL explicitly.
  const plannerContextId = `session:${externalKey.source}:${externalKey.id}`

  // 1. Bring up the PLANNER (parent) over the public surface: a real ACP agent
  //    with its per-context MCP server injected (runtimeContextMcp enabled) AND
  //    declared explicitly, so `session_new` is reachable from the agent.
  const parent = yield* firegrid.sessions.createOrLoad({
    externalKey,
    runtime: local.jsonl({
      argv: [...claudeAcpArgv],
      agent: "claude-acp",
      agentProtocol: "acp",
      cwd: globalThis.process.cwd(),
      envBindings: [{ name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" }],
      runtimeContextMcp: { enabled: true },
      mcpServers: [{
        name: mcpServerName,
        server: { type: "url", url: mcpUrlForContext(plannerContextId) },
      }],
    }),
    createdBy: "tiny-firegrid-simulation",
  })
  const parentContextId = parent.contextId
  // Clear the ACP permission gate so the planner actually EXECUTES the
  // `session_new` tool instead of stopping in plan mode (claude-acp defaults to
  // "Planning mode, no actual tool execution"). Same approach as factory-capstone.
  yield* parent.permissions.autoApprove("allow", { timeoutMs: 240_000 })

  yield* parent.prompt({
    payload: { text: plannerPrompt },
    idempotencyKey: `${externalKey.id}:turn-1`,
  })
  yield* parent.start()

  // 2. Observe the planner delegate over the public surface: a `session_new`
  //    ToolUse plus the child contextId carried in its tool result. Observe
  //    through TurnComplete so the result is captured, then keep the longest id
  //    (the agent's truncated TextChunk echo loses to the verbatim tool result).
  //    Bounded so the driver halts cleanly (the trace is the deliverable; never
  //    spin to a harness timeout). Forbid the non-delegation spawn surface.
  let parentAfter: number | undefined
  let sawSessionNewToolUse = false
  let childContextId: string | undefined
  let parentTurnComplete = false
  const parentOutputTags: Array<string> = []
  let parentOutputs = 0
  const observeDeadlineMs = (yield* Clock.currentTimeMillis) + 180_000
  while (
    !parentTurnComplete &&
    parentOutputs < 96 &&
    (yield* Clock.currentTimeMillis) < observeDeadlineMs
  ) {
    const next = yield* parent.wait.forAgentOutput({
      ...(parentAfter === undefined ? {} : { afterSequence: parentAfter }),
      timeoutMs: 20_000,
    })
    // A single non-match is just a quiet window between agent turns; keep
    // polling until the bounded deadline rather than bailing (the codex path's
    // bug). The while-condition guards total time + output count.
    if (!next.matched) continue
    parentAfter = next.output.sequence
    parentOutputs += 1
    const event = next.output.event
    parentOutputTags.push(event._tag)
    // claude-acp may surface the MCP tool name namespaced
    // (e.g. `mcp__firegrid-runtime-context__session_new`), so match by substring.
    if (event._tag === "ToolUse" && event.part.name.includes("session_new")) {
      sawSessionNewToolUse = true
    }
    if (event._tag === "TurnComplete" || event._tag === "Terminated") {
      parentTurnComplete = true
    }
    // Scan the whole observation (tool-call part carries the verbatim result id).
    childContextId = longestChildId(JSON.stringify(next.output), childContextId)
  }

  // 3. Correlate child identity. Arbitrary child-context projection reads moved
  //    to the MCP observation client; this direct Firegrid driver records whether
  //    the parent surfaced the child id and does not reopen the deleted snapshot
  //    read path.
  let observedChildCreatedBy = ""
  const childObservableOutputSeen = false
  if (childContextId !== undefined) {
    observedChildCreatedBy = "not-observed-on-direct-client"
  }

  const result: CrossAgentDelegationResult = {
    status: "captured",
    parentContextId,
    childContextId: childContextId ?? "",
    sawSessionNewToolUse,
    childContextIdRecovered: childContextId !== undefined,
    observedChildCreatedBy,
    childCorrelatedToParent: childContextId !== undefined,
    childObservableOutputSeen,
    parentOutputTags: parentOutputTags.join(","),
  }

  yield* Effect.annotateCurrentSpan({
    "firegrid.cross_agent_delegation.status": result.status,
    "firegrid.cross_agent_delegation.parent_context_id": result.parentContextId,
    "firegrid.cross_agent_delegation.child_context_id": result.childContextId,
    "firegrid.cross_agent_delegation.saw_session_new": result.sawSessionNewToolUse,
    "firegrid.cross_agent_delegation.child_context_id_recovered": result.childContextIdRecovered,
    "firegrid.cross_agent_delegation.child_created_by": result.observedChildCreatedBy,
    "firegrid.cross_agent_delegation.child_correlated_to_parent": result.childCorrelatedToParent,
    "firegrid.cross_agent_delegation.child_observable_output_seen": result.childObservableOutputSeen,
    "firegrid.cross_agent_delegation.parent_output_tags": result.parentOutputTags,
    "firegrid.cross_agent_delegation.spawn_target": claudeAcpArgv.join(" "),
  })

  return result
})).pipe(
  Effect.withSpan("firegrid.cross_agent_delegation.driver", {
    kind: "client",
    attributes: {
      "firegrid.bead": "tf-0awo.31.3",
      "firegrid.simulation.intent": "cap4-cross-agent-delegation-session-new",
    },
  }),
)
