# tf-0awo.31.3 — cap-4 cross-agent delegation (parent → child via `session_new`)

**Bead:** tf-0awo.31.3 (cap-4 slice, under tf-0awo.31)
**Sim:** `packages/firelab/src/simulations/cross-agent-delegation`
**Acceptance role:** live end-to-end acceptance that #831's `session_new`/`session_prompt`
lowering performs observable parent → child delegation over the public surface.

## TL;DR

Cross-agent delegation through `session_new` is reachable **only by an ACP agent that
calls the host-bound runtime-context MCP server.** A deterministic `stdio-jsonl` (`"raw"`)
agent emitting a `tool_use` event **cannot** trigger `session_new` *by construction* — so
the sim spawns a real off-the-shelf `@agentclientprotocol/claude-agent-acp` ACP agent
(`runtimeContextMcp: { enabled: true }` + an explicit `mcpServers` URL, an MCP-bound host),
clears the ACP permission gate (`permissions.autoApprove`), and prompts the planner — as a
first-person operator request — to call `session_new`. The delegated child is itself a
claude-acp agent (it inherits the parent's argv + config + `envBindings`), prompted and
started by the dispatch, and emits its observable marker into its own context's output
stream. Correlation is observed over the public surface via the `session.contextId` the
`session_new` tool result hands back into the parent's `ToolUse` observation, then a
read-only `firegrid.open(childContextId)` confirms `createdBy === mcp:<parentContextId>`
and the child marker. Gated on `ANTHROPIC_API_KEY`; absent → the driver halts `blocked` (a
legitimate finding outcome, same contract as `factory-capstone`). **Result: fully positive
end-to-end (see Observations).**

## Source-verified architecture (why the first approach was wrong)

The original driver spawned a deterministic `stdio-jsonl` agent that emitted
`{ type: "tool_use", name: "session_new", ... }`. The trace showed `saw_session_new = true`
but **no child ever spawned** (one process; zero session-start spans) and the agent's
`tool_result` was a `{ tool, input }` *echo*. Three independent source reads explain this:

1. **The default tool executor echoes.** `packages/runtime/src/unified/host.ts:116,333` —
   `FiregridRuntime`'s default `ToolExecutor` returns `JSON.stringify({ tool, input })`. A
   host composed as `FiregridRuntime(cfg, defaultProductionAdapterLayer())` (the original
   `host.ts`) never dispatches `session_new`; it echoes the call back.

2. **The codec `tool_use` path is unwired ("FUTURE").**
   `packages/runtime/src/unified/mcp-host/tool-dispatch.ts:13-18` states the shared
   `FiregridAgentToolExecutor` lowering is reached by the **MCP-entry** path today; the
   "wire/codec path" that would adapt an agent `tool_use` to the executor is explicitly
   future work. `codec-adapter.ts` contains **no** agent-`ToolUse` → executor routing.

3. **`stdio-jsonl` has no MCP slot.** `packages/runtime/src/unified/codec-adapter.ts:353` —
   the injected runtime-context MCP server is handed to the agent **only** via
   `AcpSessionOptions.mcpServers` on the ACP codec; the `"raw"` codec gets none. So a
   `stdio-jsonl` agent has no MCP transport to reach `session_new` either.

**Conclusion:** a `"raw"` agent has *neither* a wired `tool_use` dispatch *nor* an MCP slot,
so it cannot invoke `session_new` at all. This is not a #831 gap — #831 wired the MCP-entry
path (acceptance: `packages/runtime/test/mcp-host/mcp-host-http-acceptance.test.ts`,
JSON-RPC `tools/call`). Exercising it end-to-end through a *spawned agent* requires an ACP
agent that loads the injected MCP server.

## `session_new` dispatch contract (source: tool-dispatch.ts:346-447)

- Child runtime intent = parent's `config` with `agent` swapped to `input.agentKind`; argv,
  `envBindings`, and `runtimeContextMcp` are inherited (the firegrid runtime-context MCP
  declaration is stripped from any explicit `mcpServers` and re-injected per-context).
- Child `externalKey = { source: "firegrid.mcp.session_new", id: "<parentContextId>:<toolUseId>" }`
  → child contextId `session:firegrid.mcp.session_new:<parentContextId>:<toolUseId>`. The
  `toolUseId` is assigned by the MCP layer (**not** driver-derivable).
- Child `createdBy = mcp:<parentContextId>` — the parent-correlation fact.
- Dispatch then `session_prompt`s the child with `input.prompt` and `HostSessionsStart`s it.
- The `tools/call` response to the parent is
  `{ session: { sessionId, contextId, status:"running", metadata:{ agentKind, parentContextId } } }`.

Because the child contextId is non-derivable, the driver recovers it over the public surface
from the value the parent agent receives and echoes — the genuine delegation correlation
channel — then opens it read-only to observe `createdBy` and the child's output.

## Observations (live run, captured trace)

The sim reaches a fully positive end-to-end result. Driver span
`firegrid.cross_agent_delegation.driver`:

- `status`: `captured` (ANTHROPIC_API_KEY present)
- `saw_session_new`: **true** — the planner called `mcp__firegrid-runtime-context__session_new`
- `child_context_id_recovered`: **true** —
  `session:firegrid.mcp.session_new:<parentContextId>:mcp:<parentContextId>:id_<random>`
- `child_created_by`: **`mcp:<parentContextId>`** → `child_correlated_to_parent`: **true**
- `child_observable_output_seen`: **true** — the delegated child emitted
  `CROSS_AGENT_DELEGATION_CHILD_OBSERVED` into its own context's output, read by
  the driver via the public `firegrid.open(childContextId).snapshot` surface

Raw-wire corroboration in the same trace: two distinct spawned processes (parent
+ child), a `session/prompt` to the child sessionId carrying the delegated prompt
(messageId `session_new:mcp:<parentContextId>:…`), and the child's
`agent_message_chunk` text `…CHILD_OBSERVED`. This is the live acceptance that
#831's `session_new` lowering performs observable parent → child delegation
end-to-end through the public surface.

## Discoveries made bringing the sim up (each was a real gap, source-verified)

1. **Spawn-target agent matters.** The deterministic `stdio-jsonl` fixture cannot
   reach `session_new` at all (§ above). `@zed-industries/codex-acp` spawns and
   ACP-initializes but emits **zero** agent output in this environment
   (corroborated by the reference `codex-acp-tool-calls` sim: both scenarios
   `output_count:0, timed_out:true`). `@agentclientprotocol/claude-agent-acp` is
   productive, so the planner (and the delegated child) are claude-acp.

2. **Claude Code treats a quoted instruction as prompt-injection.** The first
   claude runs produced text but **no** tool call: the agent (Claude Code under
   the hood) read the driver prompt as a "local command message" injection and
   declined ("there's no genuine user request here"). Fixes: send the prompt as a
   first-person operator request (not a quoted "do X" block) and pass it as a
   `{ text }` user content block (a bare string was framed as non-user).

3. **Plan mode / permission gate.** claude-acp defaults to "Planning mode, no
   actual tool execution"; the planner must clear the ACP permission gate
   (`session.permissions.autoApprove("allow", …)`) before prompt/start, else it
   plans without executing.

4. **Host must wire `HostPlaneChannelRouter`.** `session_new` lowers into
   host-plane create-or-load + prompt + start, dispatched through the
   **runtime-optional** `HostPlaneChannelRouter` (a `serviceOption` lookup, not a
   type-level requirement — `ToolDispatchLive`'s only typed dependency is
   `WorkflowEngine`). Without it the tool fails at runtime with
   `session tools require HostPlaneChannelRouter`. The host provides it via
   `Layer.provideMerge(HostPlaneSessionControlRouterLive)` into the tool-dispatch
   layer; the router's host-plane channels resolve from `FiregridRuntime`. The
   `RuntimeChannelRouter`/fact-stream machinery is **not** needed by `session_new`
   (only by `wait_for`), so it is intentionally omitted.

5. **The child contextId is a host-owned fact the client cannot predict.** Its
   `toolUseId` carries a host-internal `id_<random>` distinct from the ACP
   `toolCallId` the agent assigns — so the driver cannot derive the child id. The
   public surface delivers it **only** through the `session_new` tool RESULT,
   which rides back into the parent's `ToolUse` observation. The agent's own
   TextChunk echo of the ~150-char opaque id is lossy/truncated, so the driver
   recovers it by scanning observations for the longest `session_new` id (the
   verbatim tool-result value beats the truncated echo). **Finding:** there is no
   first-class "observe my delegated child" client verb; cross-agent correlation
   currently rides the tool result + `createdBy = mcp:<parentContextId>`.

## Reproducibility / CI note

The positive path depends on a live LLM (parent + child are real claude-acp
agents) and `ANTHROPIC_API_KEY`. Without the key the driver halts `blocked`
(recorded, not a failure). Because the planner is an LLM, tool-calling is not
bit-deterministic; the driver draws no verdict and records observations, so a run
where the planner declines still halts cleanly with the trace showing how far the
choreography got.

## Methodology compliance

- Driver imports `@firegrid/client-sdk` + Effect only; no host handle imports; no verdict
  (records observations, emits a span tree). Trace + this prose are the deliverable.
- The only fixture is a real off-the-shelf spawn target
  (`@agentclientprotocol/claude-agent-acp`) — no backdoor, no sim-only executor. The host
  composes the real unified `FiregridRuntime` + `FiregridMcpServerLayer` + `ToolDispatchLive`
  + `ContextResolver` + `HostPlaneSessionControlRouterLive`, the production session_new path.
- Bounded windows; the driver halts cleanly (`blocked` without a key, or recorded
  observations) rather than spinning to a harness timeout.

Related: `docs/findings/tf-ll90-9-2-codex-acp-tool-calls-create-or-load-gap.md`.
