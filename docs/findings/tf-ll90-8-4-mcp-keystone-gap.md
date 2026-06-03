# tf-ll90.8.4 — THE THREAD keystone: migrate control-plane-cancel-close onto mcp.ts + GAP report

**Verdict: the migration is BLOCKED by a GAP. The thread is NOT "pure migration"
— `mcp.ts` must be EXTENDED first.** The cancel/close terminal verbs map cleanly
to MCP tools, but the session *provisioning* this sim depends on
(launch-with-raw-runtime, attach-by-id, explicit start-with-offset) has **no MCP
surface**. Per the task, I report the gap and stop — I did **not** hack around it
or leave a half-migrated/hybrid driver in the tree.

All claims below are **source-verified** (exact symbols cited), not inferred.

## Per-call MAPPED / GAP table

The sim's driver (`control-plane-cancel-close/driver.ts`) makes exactly these
`@firegrid/client-sdk/firegrid` calls:

| # | firegrid.ts call | what it does (channel target) | mcp.ts? | evidence |
|---|---|---|---|---|
| 1 | `firegrid.launch({ runtime: local.jsonl({ argv, agentProtocol }), requestedBy })` | create a `RuntimeContext` from a **raw** runtime spec (custom argv → the test's fake-acp-agent), client-minted contextId, via `HostContextsCreateChannel.call` | **GAP** | No create/launch tool exists. Full MCP toolkit = `sleep, wait_for, wait_until, send, call, wait_any, session_new, session_prompt, session_cancel, session_close, execute` (`mcp-host/toolkit-layer.ts:87-107`). The only creation primitive, `session_new`, takes `{ agentKind, prompt, options }` — `agentKind`+`prompt` both **required** (`agent-tools/schema.ts:479-501`) — and **cannot** express a raw `local.jsonl({argv})`; it derives the child runtime by *inheriting a parent context's* `config.argv` and overriding only `agent` (`tool-dispatch.ts:410-456 childRuntimeIntent/runSessionNew`). That parent context must already exist — resolved via `ContextResolverTag` or it fails `"runtime context … was not found"` (`tool-dispatch.ts:393-402`). So creation presupposes a context registered **out-of-band via firegrid.ts**. |
| 2 | `firegrid.sessions.attach({ sessionId })` | wrap an existing contextId as a session handle (no I/O) — `makeSessionHandle(sessionId)` (`firegrid.ts:1163-1169`) | **GAP** | `FiregridMcpClient` only yields a handle from `sessions.createOrLoad` (= `session_new`) (`mcp.ts:127-131, 547-563`). There is no attach-by-id. (Mitigation: cancel/close take a bare `sessionId` via `callTool`, so a *handle* isn't strictly required for #4/#5.) |
| 3 | `session.start() → { offset }` | start the session and return the start-event offset — `hostSessionsStartChannel.binding.append({ sessionId })` (`firegrid.ts:1087-1093`) | **GAP** | No standalone start tool. `HostSessionsStartChannelTarget` is reachable **only internally** from `session_new`'s bundled sequence (`tool-dispatch.ts:494-500`), not as a callable tool, and returns **no offset**. `session_new` bundles create+prompt+start, so "create, then start separately, capturing the offset" is not expressible. |
| 4 | `session.cancel({ reason })` | terminal cancel — `cancelSession` → `SessionCancelChannelTarget` (`firegrid.ts:1094-1101, 952-974`) | **MAPPED** | `mcp.callTool("session_cancel", { sessionId, reason })`. Tool registered (`toolkit-layer.ts:103-104`), dispatched (`tool-dispatch.ts:663` → `runSessionCancel:542` → `hostPlaneDispatch(SessionCancelChannelTarget,"call")`), schema `{ sessionId, reason? } → { cancelled: true, sessionId }` (`agent-tools/schema.ts:577-605`). |
| 5 | `session.close({ reason })` | terminal close — `closeSession` → `SessionCloseChannelTarget` (`firegrid.ts:1102-1109, 976-998`) | **MAPPED** | `mcp.callTool("session_close", { sessionId, reason })`. Tool registered (`toolkit-layer.ts:105-106`), dispatched (`tool-dispatch.ts:672` → `runSessionClose:558` → `hostPlaneDispatch(SessionCloseChannelTarget,"call")`), schema `{ sessionId, reason? } → { closed: true, sessionId }` (`agent-tools/schema.ts:607-634`). |

**Not used by this sim** (so not blocking here, but relevant to the fan-out):
`channels.send/waitFor/call` — not used; `wait.*` — not used; `permissions.respond`
— not used. (The generic `send`/`call` MCP tools dispatch on the **agent-facing**
`RuntimeChannelRouter` (`tool-dispatch.ts:164-188, 627-644`), not the host-plane
`HostContextsCreate`/`HostSessionsStart` targets, and `channel` is an "opaque
host-declared channel name" — so reaching launch/start through generic `call`
would be both unsupported *and* a substrate leak the §7 boundary forbids. Not a
path.)

## Why this is the keystone result

The asymmetry is the whole finding: **the MCP host exposes the terminal verbs
(`session_cancel`, `session_close`) as tools, but NOT the provisioning verbs
(context-create / session-start).** `session_new` is the *agent-facing* creation
primitive — an agent spawning a child that inherits its own parent context's
runtime — and it structurally **presupposes a parent `RuntimeContext` that is
registered via firegrid.ts**, not MCP.

This is confirmed by the two "reference" sims that supposedly prove mcp.ts is
sufficient: `mcp-client-sdk-gateway/driver.ts` and `mcp-client-sdk-observations/driver.ts`
are **hybrid** — both still call `firegrid.sessions.createOrLoad({ runtime:
local.jsonl({ argv }) })` to register the parent context (driver.ts:118-130 /
137-149) and carry `Firegrid | FiregridConfig` in their R-channel, then drive the
*agent session* (prompt/permission/result/observations) through mcp.ts. They do
**not** create their root context via mcp.ts. So firegrid.ts cannot be deleted on
the strength of those two sims.

## Decision for the coordinator — EXTEND mcp.ts first (not pure migration)

To converge all 20 consumers off firegrid.ts and delete it, the launch/start gap
must be closed. Three shapes (coordinator to choose):

1. **Add client/operator-facing MCP tools** for context-create (raw runtime, the
   dual of `firegrid.launch` / `HostContextsCreateChannel`) and session-start
   returning an offset (dual of `HostSessionsStartChannel`), then surface them on
   `FiregridMcpClient` (e.g. `client.launch(...)`, `handle.start()`). This is the
   most faithful 1:1 and unblocks every launch-based sim. **Caveat:** these are
   *client-plane* operations; exposing them as agent-callable MCP tools must
   respect the §7 agent/host-plane boundary (they belong on the host-plane /
   consumer face, not the agent dynamic plane) — i.e. extend the *consumer* MCP
   surface, not the agent toolkit.
2. **Host owns context creation**: the host pre-registers its bound context, and
   sims drive only `session_new`/cancel/close. Changes the sim's shape
   (parent+child, prompt-driven, agentKind instead of a raw test agent) and reads
   as host pre-provisioning — likely a behavioral change to several sims, and does
   not give back explicit start / start-offset.
3. **Accept a permanent hybrid** (firegrid.ts for launch, mcp.ts for everything
   else) — but then firegrid.ts is **not** deletable, which contradicts the
   thread's goal.

Recommendation: **(1)** — it is the only shape that lets firegrid.ts be deleted
while preserving each sim's existing creds-free, raw-runtime, explicit-start
test semantics. This gap is **general**: every sim that launches a context with a
raw runtime via `firegrid.launch` / `firegrid.sessions.createOrLoad` (most of the
20) hits it, so the decision applies fleet-wide, not just to this one sim.

## Scope honesty

Per the task ("if a GAP blocks the migration … report the gap and stop; do NOT
hack around it or reach back into firegrid.ts/channels"), the driver was **left
unchanged** — a half-migrated/hybrid driver would misrepresent the thread as
unblocked. The deliverable is this gap report. The MAPPED rows are
source-verified across three independent layers (schema → toolkit registration →
dispatch arm + channel target); the end-to-end run of the *migrated* path was not
performed because the launch GAP makes it impossible to construct the session
purely via mcp.ts — which is itself the finding.
