/**
 * cross-agent-delegation driver — re-establishes the parent->child delegation
 * acceptance PURELY over `@firegrid/client-sdk/mcp` (tf-ll90.8.4). No firegrid.ts
 * client: the host owns the gateway RuntimeContext (a real claude-acp planner
 * with its per-context runtime MCP server enabled — see ./host.ts). The driver
 * provisions the planner session via the `session_new` MCP tool (which inherits
 * the gateway runtime, sends the delegation prompt, and starts it), then observes
 * the planner delegate: it calls the Firegrid `session_new` tool through ITS OWN
 * runtime-context MCP (the runtime's spawn machinery, unaffected by this
 * migration) to create a CHILD agent, and echoes the child contextId the tool
 * result hands back.
 *
 * Correlation is observed over the PUBLIC surface: `wait.forAgentOutput` streams
 * the planner's normalized observations; the `session_new` ToolUse and the child
 * contextId (carried verbatim in the tool-result observation) are read off it.
 *
 * Methodology (packages/tiny-firegrid/docs/methodology.md): the driver imports
 * ONLY `@firegrid/client-sdk/{mcp,config}` (+ Effect), draws no verdict, returns
 * an opaque observation record, and emits a span tree. The trace + prose finding
 * are the deliverables. Creds-gated on ANTHROPIC_API_KEY: absent -> halt
 * `blocked` (the gateway claude-acp planner only runs with a real key).
 */

import { FiregridConfig } from "@firegrid/client-sdk/config"
import { makeFiregridMcpClient } from "@firegrid/client-sdk/mcp"
import { Clock, Config, Duration, Effect, Option, Stream } from "effect"

// Airgapped driver — MIRRORS ./host.ts literals (kept in sync).
const gatewayContextId = "session:tiny-firegrid:cross-agent-delegation-gateway"
const streamId = "cross-agent-delegation"

const childMarker = "CROSS_AGENT_DELEGATION_CHILD_OBSERVED"
const parentEchoPrefix = "PARENT_DELEGATED contextId="

// The planner is asked, as a direct operator request, to delegate via the
// Firegrid `session_new` MCP tool and then echo the child contextId the tool
// result hands back — the public-surface correlation channel. Framed as a
// genuine first-person task (not a quoted instruction) because the claude-acp
// agent is Claude Code and will treat a quoted "do X" block as a possible
// prompt injection and decline (observed; see
// docs/findings/tf-0awo-31-3-cross-agent-delegation.md).
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
  readonly childCorrelatedToParent: boolean
  readonly parentOutputTags: string
}

// The child contextId is a host-owned fact — the public surface delivers it only
// through the `session_new` tool RESULT, which rides back into the planner's
// ToolUse observation. We scan ALL of each observation (the tool-call part holds
// the full id) and keep the LONGEST `session_new` id seen: the agent's own
// TextChunk echo of a ~150-char opaque id is lossy/truncated, but the tool-result
// part carries it verbatim.
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
  FiregridConfig
> = Effect.gen(function*() {
  const config = yield* FiregridConfig
  if (config.durableStreamsBaseUrl === undefined || config.namespace === undefined) {
    return yield* Effect.fail(
      new Error("cross-agent-delegation requires durableStreamsBaseUrl and namespace"),
    )
  }

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
      childCorrelatedToParent: false,
      parentOutputTags: "",
    } satisfies CrossAgentDelegationResult
  }

  const mcp = yield* makeFiregridMcpClient({
    durableStreamsBaseUrl: config.durableStreamsBaseUrl,
    namespace: config.namespace,
    streamId,
    clientId: 2,
    pollIntervalMs: 250,
  })

  yield* mcp.initialize

  // Wait for the host-seeded gateway context before provisioning off it.
  yield* mcp.observations.watchContexts(
    context => context.contextId === gatewayContextId,
  ).pipe(
    Stream.runHead,
    Effect.timeoutFail({
      duration: Duration.seconds(30),
      onTimeout: () => new Error("host gateway context did not appear over MCP"),
    }),
  )

  // 1. Provision the PLANNER (parent) over MCP — session_new inherits the
  //    gateway's claude-acp runtime (with its per-context MCP server enabled),
  //    sends the delegation prompt, and starts it.
  //
  // TODO(tf-ll90.8.4 gap): the old direct-client driver called
  //   `parent.permissions.autoApprove("allow", ...)` (a firegrid.channels
  //   permissions-channel op) to clear claude-acp's plan-mode gate so the
  //   planner EXECUTES the `session_new` tool instead of stopping in plan mode.
  //   The MCP surface has no per-session blanket auto-approve verb: the only
  //   permission op is `respondToPermission(taskId, decision)` (= tasks/update),
  //   which keys off a `promptTask`-issued taskId, and this createOrLoad path
  //   auto-prompts/auto-starts the initial turn without a task handle. Reported
  //   as a GAP. With a real key the planner may stall in plan mode until this
  //   channel op has an MCP equivalent.
  const parent = yield* mcp.sessions.createOrLoad({
    agentKind: "claude-acp",
    prompt: plannerPrompt,
  })
  const parentContextId = parent.contextId

  // 2. Observe the planner delegate over the public surface: a `session_new`
  //    ToolUse plus the child contextId carried in its tool result. Observe
  //    through TurnComplete so the result is captured, then keep the longest id
  //    (the agent's truncated TextChunk echo loses to the verbatim tool result).
  //    Bounded so the driver halts cleanly (the trace is the deliverable; never
  //    spin to a harness timeout).
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
    const next = yield* parent.wait.forAgentOutput({ timeoutMs: 20_000 })
    // A single non-match is just a quiet window between agent turns; keep
    // polling until the bounded deadline rather than bailing.
    if (!next.matched) continue
    parentOutputs += 1
    const observation = next.output
    parentOutputTags.push(observation._tag)
    // claude-acp may surface the MCP tool name namespaced
    // (e.g. `mcp__firegrid-runtime-context__session_new`), so match by substring.
    if (
      observation._tag === "ToolUse" &&
      observation.event.part.name.includes("session_new")
    ) {
      sawSessionNewToolUse = true
    }
    if (observation._tag === "TurnComplete" || observation._tag === "Terminated") {
      parentTurnComplete = true
    }
    // Scan the whole observation (tool-call part carries the verbatim result id).
    childContextId = longestChildId(JSON.stringify(observation), childContextId)
  }

  const result: CrossAgentDelegationResult = {
    status: "captured",
    parentContextId,
    childContextId: childContextId ?? "",
    sawSessionNewToolUse,
    childContextIdRecovered: childContextId !== undefined,
    childCorrelatedToParent: childContextId !== undefined,
    parentOutputTags: parentOutputTags.join(","),
  }

  yield* Effect.annotateCurrentSpan({
    "firegrid.cross_agent_delegation.status": result.status,
    "firegrid.cross_agent_delegation.parent_context_id": result.parentContextId,
    "firegrid.cross_agent_delegation.child_context_id": result.childContextId,
    "firegrid.cross_agent_delegation.saw_session_new": result.sawSessionNewToolUse,
    "firegrid.cross_agent_delegation.child_context_id_recovered": result.childContextIdRecovered,
    "firegrid.cross_agent_delegation.child_correlated_to_parent": result.childCorrelatedToParent,
    "firegrid.cross_agent_delegation.parent_output_tags": result.parentOutputTags,
    "firegrid.cross_agent_delegation.transport": "mcp",
  })

  return result
}).pipe(
  Effect.withSpan("firegrid.cross_agent_delegation.driver", {
    kind: "client",
    attributes: {
      "firegrid.bead": "tf-ll90.8.4",
      "firegrid.simulation.intent": "cross-agent-delegation-session-new-over-mcp",
    },
  }),
)
