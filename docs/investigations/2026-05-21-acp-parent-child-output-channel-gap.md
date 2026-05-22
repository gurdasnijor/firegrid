# Findings: live multi-tool ACP turn — permission fix validated + parent→child output channel gap

**Date:** 2026-05-21
**Surface:** live Zed → `firegrid acp` (claude-acp), permission auto-approve (PR #628) in effect
**Method:** drove a real agent through a multi-tool turn (`session_new` → `sleep` → `session_prompt` → `wait_for`), captured `.firegrid/acp-trace.jsonl`, analyzed with `scripts/acp-trace-health.py` (tf-7008) + DuckDB drill-down.
**Status:** permission P0 (#628) **validated live**; one **new capability-gap finding** (no parent→child output channel); two trace-tooling clarifications.

---

## 0. TL;DR

- **PR #628 holds under real load.** A turn that fired 7 permission-gated tools shows a clean **permission round-trip 7 : 7 : 7** (request : respond.call : response). No deadlocks.
- The agent successfully ran `session_new` (spawned child), `sleep`, and `session_prompt "hi"` to the child — all end-to-end.
- **New finding (capability gap):** a parent agent can *spawn* and *prompt* a child session but has **no ingress channel to observe the child's reply**. The agent tried 10 channel names via `wait_for`; all returned `ToolInvalidInput: unknown channel`. Verified in code: the agent-facing channel surface has no child-output target.
- **Clarifications vs. the raw health report:**
  - The 1 `acp_stdio_edge.prompt timeout` is a **stale earlier `schedule_me` turn** (context `…fad1a476`), *not* this turn. `wait_for` on an unknown channel **fails fast** (`ToolInvalidInput`), it does not hang.
  - `tool-call balance result=0 / open=16` is a **script metric artifact** (no span is literally named "…result" on this codec path), not a real "tools didn't return." Tools returned (dedicated `firegrid.host.agent_tool.session_new` / `…session_prompt` spans, status ok).

---

## 1. Permission fix — validated live (PR #628)

`scripts/acp-trace-health.py` Axis-1:

```
ok permission round-trip:  request=7 respond.call=7 response=7 wf.send=51  (want request==response)
```

7 gated tool invocations, 7 auto-approve dispatches (`host.permissions.respond`), 7 codec responses. The fix that unblocked `sleep` now holds across a full multi-tool turn including child-session spawn. (`wf.send=51` is the permission-response workflow's internal send fan-out — benign.)

Tools that executed this turn (DuckDB, context `…acp_3a15b209…`):
- `firegrid.host.agent_tool.session_new` ×1 (status ok) — child `…Qi2ru26N1wqBhKw7` created, running
- `firegrid.host.agent_tool.session_prompt` ×1 (status ok) — `"hi"` appended to child (`appended:true`)
- `sleep` (completed)

---

## 2. NEW FINDING — no parent→child output observation channel

### 2.1 Symptom (agent self-report)
After `session_new` + `session_prompt`, the agent tried to `wait_for` the child's reply and could not find a channel. It guessed 10 names, all rejected.

### 2.2 Trace evidence (DuckDB)
All 10 are `Toolkit.handle` error spans, tag `ToolInvalidInput`, from the parent Zed context `ctx_ext_…acp_3a15b209…`:

```sql
SELECT status_msg, count(*) n FROM spans
WHERE name='Toolkit.handle' AND status_code='2' GROUP BY status_msg;
```

| `wait_for` channel guess | result |
|---|---|
| `session.output`, `session.self.output`, `session.message`, `session.reply` | `unknown channel` |
| `session.child.output`, `child.session.output`, `session.child.lifecycle` | `unknown channel` |
| `agent.output`, `agent.message`, `acp.output` | `unknown channel` |

These **fail fast** (ToolInvalidInput) — they are *not* timeouts. The turn did not hang.

### 2.3 Verified in code (not just the agent's word)
The agent-facing ingress channel targets (`grep makeChannelTarget packages/protocol/src/channels`):

```
host.contexts, host.prompt, host.sessions.create_or_load,
session.log, session.prompt, session.self.checkpoint, session.self.lifecycle
```

- The only `wait_for`-able session channels are `session.self.{lifecycle,checkpoint}` — they describe **this** session, not a child.
- `session.agent_output` exists (`packages/protocol/src/channels/session-agent-output.ts`) but is **host-side only** — the ACP stdio edge uses it to forward agent output to ACP (`acp-stdio-edge.ts:326`); it is not exposed as an agent ingress channel.
- `session_new` returns a `sessionId` handle (`schema.ts:410 firegrid.agentTool.sessionNew.output`) but no output-channel binding.

**Conclusion:** the spawn/prompt half of child orchestration exists; the *observe* half does not. A parent cannot durably read a child's output through the channel surface. This blocks the most basic delegation pattern (spawn → prompt → await result).

### 2.4 Fix shapes (agent-proposed, both plausible)
- **(a)** Host registers a child-output ingress channel on the parent surface (e.g. `session.child.output` keyed by the child `sessionId` from `session_new`), `wait_for`-able.
- **(b)** A `session_read`-style verb that reads a child session's output stream by handle.

Either way the contract must be host-declared (parent must not predict the channel name — the 10 guesses are exactly the "client predicting host facts" anti-pattern). Bias toward (a): it reuses the existing `wait_for`/ingress machinery rather than adding a verb.

---

## 3. Trace-health metrics (this accumulated capture)

`python3 scripts/acp-trace-health.py .firegrid/acp-trace.jsonl` — 26,236 spans / 99 traces / 4 contexts (append-mode, mixes runs).

### Axis 1 — bugs
| signal | value | note |
|---|---|---|
| permission round-trip | 7:7:7 | ✅ #628 holds |
| error spans | 12 | 10 = the `wait_for` unknown-channel guesses (§2); 1 = stale `schedule_me` timeout; 1 = `open_byte_pipe` "local process failed to start" (transient child-agent spawn) |
| `acp_stdio_edge.prompt timeout` | 1 | **stale `schedule_me` turn (`…fad1a476`)**, not this turn — `durable_table.rows max=30009ms` long-poll |
| tool-call `result=0 / open=16` | — | **script metric artifact** — no "…result" span on this codec path; tools did return |
| interrupted spans | 214 | turn teardown + cancelled waits |

### Axis 2 — data-flow / fragmentation
- **Child context `…Qi2ru26N1wqBhKw7` split across 4 traces** (26 / 22 / 9 / 1 spans) — no single trace for the child lifecycle.
  ```sql
  SELECT traceId, count(*) n FROM spans
  WHERE context_id LIKE '%Qi2ru26N1wqBhKw7%' GROUP BY traceId ORDER BY n DESC;
  ```
- `contexts split across traces: 3 of 3`; 2 traces with >1 root (163, 79 roots). Even with `tf-783y` (byte-attr linking) merged, child-session spans aren't unified — the trace-linkage gap (prior §7.4) is only partly closed.
- 240 orphan spans (parent absent): `acp.session_update` ×177, `execution.execute` ×36, `permission_request` ×7 (cross-process boundary).
- **output-read amplification 1.66×** (258 initial reads / 155 distinct seq) — residual re-walk, the `tf-aseo` durable-loop-state target. Far below the old storm; not yet 1.0.

### Axis 3 — chatter
- `firegrid.durable_table.get` 6000 spans (23% of all) @ 0.04ms — dominant read chatter.
- Wall-time budget dominated by long-polls: `session_agent_output` 144s/49x, `durable_table.rows` 144s/55x (includes the stale 30s timeout + blocking waits).

---

## 4. DuckDB drill-down recipe (reusable)

Load (raw JSON objects; robust to heterogeneous `events`):

```sql
CREATE TABLE spans AS
SELECT json->>'name' AS name, json->>'traceId' AS traceId, json->>'spanId' AS spanId,
  json->>'parentSpanId' AS parentSpanId,
  (json->'startTime'->>0)::DOUBLE*1000 + (json->'startTime'->>1)::DOUBLE/1e6 AS start_ms,
  (json->'duration'->>0)::DOUBLE*1000 + (json->'duration'->>1)::DOUBLE/1e6 AS dur_ms,
  json->'status'->>'code' AS status_code, json->'status'->>'message' AS status_msg,
  json->'attributes'->>'firegrid.context.id' AS context_id, json->'attributes' AS attributes
FROM read_json_objects('.firegrid/acp-trace.jsonl');
```

Then the queries in §1–§3 (tool errors by `status_msg`; `host.agent_tool.*` per-tool; per-context per-trace fragmentation; timeout-trace composition).

---

## 5. Recommendations

1. **File the parent→child output channel gap as a P-ticket** (§2). It blocks delegation. Prefer fix-shape (a): host-declared `session.child.output` (or similar) keyed by the `session_new` handle, `wait_for`-able. Host-owned contract — not agent-predicted.
2. **Two `acp-trace-health.py` metric fixes** so future runs are not misleading:
   - `result=0 / open=16`: define the tool-result span correctly for the codec path (or count `Toolkit.handle` success vs. error) so "open" reflects genuine hangs only.
   - Distinguish *fast tool errors* (`ToolInvalidInput`) from *turn timeouts* in Axis-1 so a `wait_for` guess-storm doesn't read as a hang.
3. **Trace fragmentation (§3 Axis-2)** is still real post-`tf-783y`: child-session spans span 4 traces. Worth confirming whether child-context spawn propagates trace context, or whether per-context traces are intended (then the metric should group by context, not penalize).
4. **`schedule_me`** remains the only true hang (separate, tracked by `tf-uoga` source-verify on main). Delete `.firegrid/acp-trace.jsonl` between captures so stale timeouts don't pollute new reports.

---

## 6. Appendix — file:line index

| Concern | Location |
|---|---|
| Agent ingress channel targets | `packages/protocol/src/channels/*` (`makeChannelTarget`) |
| Host-side agent-output channel (not agent-facing) | `packages/protocol/src/channels/session-agent-output.ts`; used `packages/host-sdk/src/host/acp-stdio-edge.ts:326` |
| `session_new` output schema (handle, no channel) | `packages/protocol/src/agent-tools/schema.ts:410` |
| Permission fix (validated here) | `packages/host-sdk/src/host/acp-stdio-edge.ts` PermissionRequest case (PR #628) |
| Trace-health script | `scripts/acp-trace-health.py` (tf-7008) |
| Prior permission deadlock finding | `docs/investigations/2026-05-21-acp-stdio-edge-permission-deadlock.md` |
