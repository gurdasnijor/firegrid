# Findings: Live ACP stdio edge silently drops `PermissionRequest` → agent tool calls deadlock

**Date:** 2026-05-21
**Surface:** live Zed → `firegrid acp` stdio edge → `claude-acp` subprocess
**Severity:** P0 for the live agent-tool path (every tool call that triggers a permission gate hangs the turn)
**Status:** root cause **verified from wire bytes**; a temporary quick fix is applied (uncommitted) and validated for `sleep`. A second, independent `schedule_me` timeout is partially diagnosed (see §6).

---

## 0. TL;DR

- When the agent invokes a Firegrid MCP tool, `claude-acp` gates it behind an ACP `session/request_permission` JSON-RPC **request** (`"id":N`, expects a response).
- The Firegrid codec turns that into a `PermissionRequest` observation and **blocks on a `Deferred<PermissionDecision>`** waiting for a response on the Firegrid permission plane.
- The **ACP stdio edge dropped that observation on the floor** (`forwardOutput` had `PermissionRequest` grouped with terminal cases under a bare `break`). Nothing ever responded → the codec's `Deferred` never resolved → `claude-acp` blocked → the host's 30s output long-poll timed out → `AcpStdioEdgeTurnOutputError{reason:"timeout"}`.
- User-visible symptom: any tool-invoking prompt (e.g. `session_new`) "times out waiting for Firegrid agent output". Pure Q&A prompts worked because they trigger no permission request.
- **Quick fix applied** (see §5): the edge now auto-approves by dispatching `host.permissions.respond` (`{ _tag: "Allow" }`). `sleep` now executes end-to-end through the live Zed path.
- This is the **same class** as the §6 dark-factory / PR #446 `canUseTool` permission gate — but that fix lived on the factory path; the live stdio edge never got an equivalent handler.

---

## 1. Environment / how the data was captured

Zed `settings.json` agent entry (`firegrid-claude`):

```jsonc
"firegrid-claude": {
  "type": "custom",
  "command": "bash",
  "args": ["-lc",
    "cd /Users/gnijor/gurdasnijor/firegrid && pnpm --silent exec tsx packages/cli/src/bin/run.ts -- acp --agent claude-acp --agent-protocol acp --secret-env ANTHROPIC_API_KEY --otel-file .firegrid/acp-trace.jsonl -- npx -y @agentclientprotocol/claude-agent-acp@0.36.1"
  ],
  "env": { "ANTHROPIC_API_KEY": "..." }
}
```

The `--otel-file` writes one OTel span per line as JSONL via `JsonlFileSpanExporter`:

- Span serialization: `packages/observability/src/node.ts:107` (`spanToJsonLine`) — fields: `name, traceId, spanId, parentSpanId, kind, startTime, endTime, duration, status, attributes, events, links, resource`.
- `startTime`/`endTime`/`duration` are `[seconds, nanoseconds]` hrtime arrays.
- **Exporter opens the file in append mode** (`createWriteStream(..., { flags: "a" })`, `node.ts:133`). Consequence: re-running without deleting the file mixes sessions. Delete `.firegrid/acp-trace.jsonl` between captures.

---

## 2. Analysis tooling (DuckDB)

The community `otlp` extension does **not** apply here: (a) it caps input at 100 MB, and (b) this file is `@effect/opentelemetry`'s flat per-span dump, not OTLP wire format (`read_otlp_traces` returns 0 rows on it). Use native `read_json_objects` instead.

### 2.1 Load pattern (robust to heterogeneous `events`)

`read_ndjson`/`read_json_auto` choke on schema inference (exception events have variable keys). Read each line as a raw JSON object and project:

```sql
-- duckdb trace.duckdb
CREATE TABLE spans AS
SELECT
  json->>'name'         AS name,
  json->>'traceId'      AS traceId,
  json->>'spanId'       AS spanId,
  json->>'parentSpanId' AS parentSpanId,
  (json->>'kind')::INT  AS kind,
  (json->'startTime'->>0)::DOUBLE*1000 + (json->'startTime'->>1)::DOUBLE/1e6 AS start_ms,
  (json->'endTime'->>0)::DOUBLE*1000   + (json->'endTime'->>1)::DOUBLE/1e6   AS end_ms,
  (json->'duration'->>0)::DOUBLE*1000  + (json->'duration'->>1)::DOUBLE/1e6  AS dur_ms,
  json->'status'->>'code'    AS status_code,   -- 1 = ok, 2 = error
  json->'status'->>'message' AS status_msg,
  json->'resource'->>'service.name'           AS service,
  json->'resource'->>'firegrid.process.role'  AS role,
  json->'attributes'->>'firegrid.context.id'  AS context_id,
  json->'attributes'                          AS attributes
FROM read_json_objects('/Users/gnijor/gurdasnijor/firegrid/.firegrid/acp-trace.jsonl');
```

Notes:
- `start`, `name` etc. are partly reserved — quote/alias carefully.
- A `WITH … SELECT` CTE only scopes to the next statement; create a `VIEW` to reuse a per-trace filter across queries.
- Nested attributes: use `->>` (e.g. `attributes->>'firegrid.side'`). To grep raw payloads, `CAST(attributes AS VARCHAR)`; to extract a single field, `attributes->>'firegrid.wire.raw'`.

### 2.2 Triage queries (reusable)

```sql
-- Spans-per-trace shape (storm detector: median tiny, max huge => replay storm)
SELECT min(c) AS min, max(c) AS max, round(avg(c),1) AS avg,
       round(median(c),1) AS median, quantile_cont(c,0.95)::INT AS p95
FROM (SELECT traceId, count(*) c FROM spans GROUP BY traceId);

-- Errors / timeouts
SELECT name, status_msg, round(dur_ms,0) AS dur_ms
FROM spans WHERE status_code='2' ORDER BY start_ms DESC;

-- Permission round-trip health (should be 1:1:1 per gated tool call)
SELECT
  count(*) FILTER (WHERE name='firegrid.agent_event_pipeline.acp.permission_request')   AS perm_requests,
  count(*) FILTER (WHERE name='firegrid.channel.host.permissions.respond.call')          AS auto_approves,
  count(*) FILTER (WHERE name='firegrid.agent_event_pipeline.acp.permission_response')   AS perm_responses
FROM spans;

-- Did a tool actually execute?
SELECT name, count(*) n FROM spans
WHERE name IN ('McpServer.tools/call','Toolkit.handle',
               'firegrid.agent-tool-call.execute','firegrid.host.agent_tools.tool_use.execute')
GROUP BY name ORDER BY n DESC;

-- Distinct contexts (>1 => a child session_new context was spawned)
SELECT count(DISTINCT context_id) FROM spans WHERE context_id IS NOT NULL;
```

### 2.3 The decisive query — agent wire bytes

The host instruments the raw `claude-acp` stdio. **This is the only window into the agent subprocess** (it does not export its own OTel). It lives on a **separate, long-lived `byte_stream` trace** (the pipe opens once per session), *not* on the per-prompt trace — which is why the failure first looked like "agent silent / Firegrid timeout."

```sql
-- Full ACP JSON-RPC the agent emitted, in order
SELECT row_number() OVER (ORDER BY start_ms) AS seq,
       (attributes->>'firegrid.wire.direction') AS dir,        -- 'out' = from agent
       (attributes->>'firegrid.wire.bytes')     AS bytes,
       substr(attributes->>'firegrid.wire.raw', 1, 200)        AS raw
FROM spans WHERE name LIKE '%local_process.stdout_bytes%' ORDER BY start_ms;

-- Reconstruct the agent's streamed text answer
SELECT string_agg(
  regexp_extract(attributes->>'firegrid.wire.raw', '"text":"(.*)"\}\}\}', 1), '' ORDER BY start_ms
) AS agent_text
FROM spans
WHERE name LIKE '%stdout_bytes%'
  AND (attributes->>'firegrid.wire.raw') LIKE '%agent_message_chunk%';
```

---

## 3. Root cause (VERIFIED)

### 3.1 The smoking gun (wire capture, first reproduction)

The agent's `stdout` (`firegrid.side:"subprocess"`, `firegrid.wire.direction:"out"`) during a `session_new` turn, chronologically:

1. `session/update` `agent_thought_chunk`
2. `session/update` `tool_call` (`status:"pending"`) — `mcp__firegrid-runtime-context__session_new`
3. `session/update` `tool_call_update` (rawInput present)
4. **`{"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{"options":[{"kind":"allow_always",…},{"kind":"allow_once",…},{"kind":"reject_once",…}],"sessionId":"…","toolCall":{"toolCallId":"toolu_…","title":"mcp__firegrid-runtime-context__session_new",…}}}`**

Then silence. The `request_permission` message appears **only outbound** — there is **no inbound response**, and **zero spans with `permission` in the name** in that capture. The host's agent-output observer span is tagged `"span.label":"⚠︎ Interrupted","status.interrupted":true` at `packages/runtime/src/channels/session-agent-output.ts:43`, and `firegrid.acp_stdio_edge.prompt` ends with:

```json
{"_tag":"AcpStdioEdgeTurnOutputError","reason":"timeout","message":"timed out waiting for Firegrid agent output"}
```

Reproduced 2/2. Each timeout trace had **0 `session_update` spans**, and the timeline was the host polling `host.channel.session_agent_output` → `durable_table.rows` repeatedly, the last long-poll blocking ~30s (`durable_table.rows` dur ≈ 30,055 ms).

### 3.2 Why — the code path

| Step | Location | Behavior |
|---|---|---|
| Agent calls `requestPermission` | `packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts:488` | Codec's `acp.Client.requestPermission` |
| Codec emits observation + **blocks** | `codecs/acp/index.ts:492-500` | `openPermissionDecision` → `emit({_tag:"PermissionRequest", permissionRequestId, toolUseId, options})` → `awaitPermissionDecision(deferred)` ← **never resolves on the live edge** |
| Observation reaches the edge | `packages/host-sdk/src/host/acp-stdio-edge.ts:357` (`forwardOutput`) | Receives `RuntimeAgentOutputObservation` |
| **The bug** | `acp-stdio-edge.ts` (pre-fix ~line 392) | `case "PermissionRequest":` was grouped with `Ready`/`TurnComplete`/`Error`/`Terminated` under a bare `break` — **silently dropped** |
| Host turn loop times out | `acp-stdio-edge.ts:298-316` (`waitForAgentOutput`), `:318-355` (`waitForTurnCompleteEffect`) | Each output wait races a `turnTimeoutMs` (default **30_000**, `:74`). 30s of no new output → `AcpStdioEdgeTurnOutputError`. |

The codec's response path *does* exist and is what the factory uses: an inbound `PermissionResponse` input intent → consumed by the runtime-context workflow → resolves the codec's `Deferred`. The live edge simply never produced that response.

### 3.3 Parallel evidence — the *other* ACP stack already encodes the right invariant

`packages/runtime/src/agent-adapters/acp/adapter.ts:238` (the `firegrid-effect-ai-native-agents` LanguageModel adapter — **not on the live edge path; nothing outside its directory imports it**) handles `requestPermission` differently and documents the invariant the codec violates:

```ts
// adapter.ts:233-252
// "we still owe ACP a response so its prompt() can resolve.
//  Always reply `cancelled`, even when we cannot notify a (gone) turn queue."
requestPermission: async params => {
  try { /* fail the current turn with PermissionRequiredButNotHandled */ }
  catch { /* runtime gone */ }
  return { outcome: { outcome: "cancelled" } }   // never auto-allow, but never hang
}
```

It declares `mayRequestPermissions: false` (`adapter.ts:37`) and references a *future* `PermissionedAdapter` capability that **does not exist yet** (only TODO comments at `mapping.ts:28,77`; `AgentAdapter.ts:10` has just the boolean flag).

---

## 4. There was no flag / config escape hatch

- The `acp` command (`packages/cli/src/bin/run.ts:798`) accepts only `--namespace, --agent, --agent-protocol, --cwd, --secret-env, --otel-file`. **No permission/auto-approve option.**
- `packages/client-sdk/src/permission-auto-approve.ts` (`autoApproveSessionPermissions`) works on the **Firegrid session-facade plane** (`session.wait.forPermissionRequest` → `session.permissions.respond`). It is wired into client-SDK app sessions, tiny-firegrid sims, and the experiment harness — **never into the ACP stdio edge**. `hostAcpLayer` (`run.ts:544`) does not fork it.

So the deadlock could only be fixed in code, not configuration.

---

## 5. The applied quick fix (temporary)

**File:** `packages/host-sdk/src/host/acp-stdio-edge.ts` (uncommitted on `main` so the live `tsx` Zed session picks it up).

Replaced the dropped `PermissionRequest` case with an auto-approve dispatched on the **already-registered** host permission-respond route:

```ts
case "PermissionRequest":
  // QUICK FIX: auto-approve so tool calls proceed instead of hanging until the
  // 30s output timeout. TODO: forward to Zed via connection.requestPermission.
  await this.run(
    this.router.dispatch({
      target: HostPermissionRespondChannelTarget,   // "host.permissions.respond"
      verb: "call",
      payload: {
        contextId: output.contextId,
        permissionRequestId: output.permissionRequestId,
        decision: { _tag: "Allow" },
      },
    }),
  )
  break
```

Supporting facts (all verified):
- Route is registered in the live edge router: `permissionRespond = makeHostPermissionRespondChannel(control)` + `runtimeRouteFromChannel(permissionRespond)` — `packages/runtime/src/channels/host-control-routes.ts:65,79`.
- Channel target `"host.permissions.respond"` — `packages/protocol/src/channels/host-control.ts:193`.
- Request schema `PermissionRespondInputSchema = { contextId, permissionRequestId, decision, idempotencyKey? }` — `packages/protocol/src/agent-tools/schema.ts:677`.
- `decision` shape `{ _tag: "Allow", optionId? }` (`optionId` optional) — `schema.ts:661`. `{ _tag: "Allow" }` matches what `permission-auto-approve.ts` and the tiny-firegrid sims send.
- Channel handler appends a permission-response input intent → resolves the codec `Deferred` — `packages/protocol/src/launch/host-control-request.ts:178-221`.
- `tsc --noEmit` on `@firegrid/host-sdk`: clean.

**Validation (post-fix trace):** the `sleep` turn shows the full round-trip and a real execution:

```
firegrid.agent_event_pipeline.acp.permission_request    1
firegrid.channel.host.permissions.respond.call          1   ← the fix
firegrid.runtime_context.workflow.permission_response.send  5
firegrid.agent_event_pipeline.acp.permission_response   1
McpServer.tools/call (sleep, 269ms)                     1   → returned {"slept": true}
```

Zed UI confirmed: "Slept 100ms (`{"slept": true}`)".

This is a stopgap. The build team should decide between (a) promoting it to an explicit `--auto-approve` flag, or (b) the real fix — forward to Zed (§7.1).

---

## 6. Secondary, independent failure: `schedule_me` times out (NOT permission)

Prompt: *"use schedule_me to sleep for 3sec and then prompt yourself to say 'hi'"* → `AcpStdioEdgeTurnOutputError{timeout}` at 32,057 ms.

Verified facts:
- Permission ratio is clean **1:1:1** and all from the `sleep` turn — `schedule_me` **never sent a permission request**, so this is not the §3 deadlock.
- The schedule_me turn's wire (after the sleep turn's `end_turn`) is only `agent_thought_chunk`/`agent_message_chunk`, then **30s of silence** → timeout.
- The handler **started**: a second `firegrid.workflow_engine.clock.schedule` fired with `firegrid.side:"agent-tools"` (the first schedule+`clock.fire` pair is `sleep`'s).
- **No completed `McpServer.tools/call` for schedule_me** — only `sleep`'s. The schedule_me tool-call span is open/unfinished.

**Verified conclusion:** schedule_me's tool handler started (registered a clock wakeup) but **never returned a result**, so the agent waited, emitted no further output, and the host timed out.

**Hypothesis (NOT yet source-verified):** `schedule_me` lowers onto `DurableClock.sleep` *plus* the canonical host prompt-append seam (per its tool doc at `packages/host-sdk/src/agent-tools/bindings/tools.ts:240-252`). The self-re-entry — append a prompt back to the *same* context mid-turn — is the likely hang: either the post-sleep prompt-append doesn't complete, or the self-prompt collides with the in-flight turn so the tool call never resolves. **Next step:** trace `toolUseToEffect`'s `schedule_me` lowering in `packages/host-sdk/src/agent-tools/.../execution`.

---

## 7. Recommendations — decomplecting the contributing issues

These are the structural knots that turned a one-line missing handler into a multi-hour, three-symptom triage.

### 7.1 Decide and unify the permission plane (the core decomplect)
There are **two parallel ACP integrations with divergent permission behavior**: the live **codec** (`codecs/acp/index.ts`, blocks on a `Deferred`) and the **agent-adapters adapter** (`agent-adapters/acp/adapter.ts`, returns `cancelled`). They encode opposite invariants. Pick one model and route the live edge through it. The intended end-state — the `PermissionedAdapter` capability stubbed in `mapping.ts` — should be built rather than left as a TODO. The real fix for the live edge is **forward to Zed**: the edge holds an `acp.AgentSideConnection` (`acp-stdio-edge.ts:129`) which exposes `requestPermission` (`sdk/dist/acp.d.ts:58`), so it can surface the prompt in Zed's native UI and feed the human decision back via the same `host.permissions.respond` route the quick fix uses.

### 7.2 Make "always owe ACP a response" an enforced invariant
The codec's `awaitPermissionDecision` (`codecs/acp/index.ts:500`) is an **unbounded** wait. Any path that fails to produce a response deadlocks the agent. Bound it: a timeout + default decision (deny/cancel), mirroring `adapter.ts:252`'s documented "always reply" rule. A blocked permission should fail *fast and typed*, never hang for 30s.

### 7.3 Eliminate silent observation drops
`forwardOutput`'s switch grouped `PermissionRequest` with terminal cases under one `break` — an unhandled-but-meaningful tag silently lost. Make each `RuntimeAgentOutputObservation` tag an explicit case (or a typed exhaustiveness check that fails the build when a new tag is added unhandled). A `PermissionRequest` arriving at a sink with no handler should at minimum log/span, not vanish.

### 7.4 Link the byte-stream trace to the prompt trace
The richest agent-side signal (`firegrid.wire.raw` on `local_process.stdout_bytes`) lives on a **separate long-lived trace** from the per-turn `acp_stdio_edge.prompt`. Diagnosing the deadlock required correlating across disconnected traces by wall-clock — three queries before the wire revealed the cause. Propagate trace context so a turn's prompt span and the agent bytes it elicited share a trace (or add a `turnId`/`promptId` link attribute on both).

### 7.5 Disambiguate the turn-timeout error
`AcpStdioEdgeTurnOutputError{reason:"timeout"}` currently collapses several distinct conditions into one opaque message: (a) agent emitted nothing, (b) agent blocked on an unanswered permission request, (c) a tool handler hung without returning (the `schedule_me` case), (d) agent crashed. The edge can distinguish these from data it already has (was a `PermissionRequest` seen and unanswered? is a `tools/call` span open?). Emit a specific reason so the next person reads the cause off the error, not off DuckDB.

### 7.6 Permission policy as first-class config
Whatever the chosen model, expose the policy explicitly (e.g. `--auto-approve allow|deny|forward` on the `acp` command, threaded through `AcpConfig` → `AcpStdioEdgeOptions`) rather than a hardcoded `Allow`. Default should be safe (forward or deny), not silent allow.

### 7.7 (Separate track) `schedule_me` self-re-entry — see §6
Independent of permissions. Likely needs the tool call to return *before* (or independently of) the scheduled self-prompt firing, so a self-scheduling tool doesn't deadlock its own turn.

### 7.8 (Pre-existing context, not this bug) trace volume / append behavior
- The exporter's append mode (`node.ts:133`) silently mixes sessions across runs — delete the file or namespace per run.
- The original 157 MB capture had a single trace of **140,717 spans** (the tf-7kq8 replay storm; #612 reduced this to ~2k but the memory note tf-aseo states #612 made the re-walk *cheap*, not *gone*). Unrelated to the permission deadlock but worth keeping the storm regression query (§2.2 spans-per-trace) in CI.

---

## 8. Appendix — key file:line index

| Concern | Location |
|---|---|
| Trace span schema / append mode | `packages/observability/src/node.ts:107`, `:133` |
| Edge: dropped PermissionRequest (now fixed) | `packages/host-sdk/src/host/acp-stdio-edge.ts:357` (`forwardOutput`), `:298-355` (turn/timeout loop), `:74` (30s default), `:129` (`AgentSideConnection`) |
| Codec: blocking requestPermission | `packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts:488-510` |
| Parallel adapter (always-respond invariant) | `packages/runtime/src/agent-adapters/acp/adapter.ts:37`, `:238` |
| Permission respond channel/route | `packages/protocol/src/channels/host-control.ts:193`; `packages/protocol/src/launch/host-control-request.ts:178`; `packages/runtime/src/channels/host-control-routes.ts:65,79` |
| Decision / respond-input schemas | `packages/protocol/src/agent-tools/schema.ts:661,677` |
| PermissionRequest observation schema | `packages/protocol/src/session-facade/schema.ts:342` |
| Client-SDK auto-approve helper (other plane) | `packages/client-sdk/src/permission-auto-approve.ts`; `packages/host-sdk/src/host/channels/session-permission/index.ts:68` |
| CLI `acp` command (no perm flag) | `packages/cli/src/bin/run.ts:798`; `hostAcpLayer` `:544` |
| `schedule_me` tool binding/doc | `packages/host-sdk/src/agent-tools/bindings/tools.ts:240-252` |
| Interrupted agent-output channel | `packages/runtime/src/channels/session-agent-output.ts:43` |
