# Handoff — Live ACP test/validation/fix loop (2026-05-21 → 22)

A working session that turned "drive a live Firegrid agent and see what breaks" into a
repeatable **drive → capture → analyze → fix/ticket** loop, found several real issues,
and landed the tooling to keep doing it. Start here if you're continuing the live-agent
validation work.

---

## 1. The loop (what we actually do)

```
prompt a real agent  →  capture OTel trace  →  analyze (3 axes)  →  fix or ticket
```

- **Drive:** a real `claude-acp` agent through the **ACP stdio edge** (the Zed path), either
  interactively in Zed or headlessly (now the `acp-tool-elicitation` sim — see §3).
- **Capture:** `firegrid acp --otel-file <path>` writes one ended OTel span per JSONL line
  (`packages/observability/src/node.ts:107` `spanToJsonLine`). hrtime fields are
  `[seconds, nanoseconds]` arrays. **The exporter appends** (`node.ts:133`), so delete the
  file between runs or per-run files mix.
- **Analyze along 3 axes:**
  1. **Bugs / correctness** — timeouts, errors, permission round-trip, hung tool calls.
  2. **Data-flow health** — trace connectedness, orphans, context fragmentation, output-read amplification.
  3. **Simplification** — chatter / duplicated stacks / overhead.
- **Fix or ticket:** verified-from-source findings → P-tickets (the docs in `docs/investigations/`).

---

## 2. Tools used (and how)

### DuckDB (the workhorse for ad-hoc trace analysis)
- **Do NOT use the community `otlp` extension** here: it caps input at 100 MB and expects OTLP
  wire format; our file is `@effect/opentelemetry`'s flat per-span dump → `read_otlp_traces` returns 0 rows.
- **Load via `read_json_objects`** (robust to heterogeneous `events`):
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
- **Gotchas:** `start`/`name` are reserved (quote/alias); a `WITH … SELECT` CTE only scopes the
  next statement (use a `VIEW` to reuse a per-trace filter); grep nested JSON with
  `CAST(attributes AS VARCHAR)`, extract one field with `attributes->>'firegrid.wire.raw'`.
- **The decisive query — agent wire bytes.** The host instruments the claude-acp subprocess stdio:
  `firegrid.agent_event_pipeline.source.local_process.stdout_bytes`, attribute
  `firegrid.wire.raw` = the **full ACP JSON-RPC both directions**. This is the *only* window into
  the agent subprocess, and it lives on a **separate long-lived `byte_stream` trace**, not the
  per-prompt trace (that disconnect cost us 3 queries before we read the wire and saw the truth).

### `scripts/acp-trace-health.py` (tf-7008, on main)
3-axis report over a trace file: `python3 scripts/acp-trace-health.py <trace.jsonl>`. Pure stdlib.
Two **known metric artifacts** (don't be misled): `tool-call result=0/open=N` is a span-name
mismatch (tools DID return), and it lumps *fast tool errors* (`ToolInvalidInput`) in with *turn timeouts*.

### Headless ACP driver → now a tiny-firegrid sim
We first built `scripts/acp-drive.mjs` (a loose Node ACP client). It was then **replaced** by a
framework-native simulation, `packages/tiny-firegrid/src/simulations/acp-tool-elicitation/`
(modeled on `acp-edge-transport`): `host = AcpStdioEdgeLive` + real claude-acp; `driver` = a
`class ElicitationClient implements acp.Client` driving the edge over an in-memory `ndJsonStream`
harness, replaying a curated prompt matrix (`prompts.ts`) one turn per span. Run:
```
ANTHROPIC_API_KEY=... TINY_FIREGRID_TIMEOUT="300 seconds" \
  pnpm --filter @firegrid/tiny-firegrid simulate:run -- acp-tool-elicitation
```
Inherits `simulate:show / perf / duckdb`. (In PR #639.) Drives the edge **in-process** — faithful
for edge *logic*, not the literal subprocess/stdio boundary.

### durable-streams stream-inspector UI (`tools/durable-streams-ui/`, in PR #639)
Vendored test-ui (reads `http://<host>:4437`, enumerates `__registry__`). Runs alongside Zed:
`pnpm --filter @firegrid/durable-streams-ui dev` → `:3000`. Shows raw runtime streams (per-context
`.state`, `runtimeOutput`, `workflow`); the `…output.N.after.0.M` keys make the durable
output-cursor visible advancing. Not Firegrid-semantic.

### cmux-browser
Used to open `localhost:3000` and read the rendered stream view directly (`cmux browser open … ; get text body`).

---

## 3. Findings (this session)

| # | Finding | Status |
|---|---|---|
| P0 | **ACP stdio edge silently dropped `PermissionRequest`** → every tool call deadlocked 30s (`forwardOutput` grouped it with terminal cases; codec blocks on an unbounded `Deferred`). | **Fixed** — #628/tf-46i4 (auto-approve via `host.permissions.respond`). Validated live 7:7:7. Doc: `docs/investigations/2026-05-21-acp-stdio-edge-permission-deadlock.md` |
| P0 | **`schedule_me` blocks the calling turn** until the scheduled `when` (inline-awaited `DurableClock.sleep + append`) → edge times out. | **Fixed** — #637/tf-5ose (fire-and-forget `ScheduledPromptWorkflow`), validated exactly-once across restart in #642/tf-sto7. Source-verified in `docs/research/tf-uoga-…FINDING.md` |
| P-finding | **No parent→child output channel** — agent can `session_new`+`session_prompt` a child but can't `wait_for` its reply (10 channel guesses all `unknown channel`). Fix = host-declared `session.child.output`. | **Open** (file a bead). Doc: `docs/investigations/2026-05-21-acp-parent-child-output-channel-gap.md` |
| Data-flow | **Trace fragmentation** — a context's spans split across 4–25 traces; byte-stream trace disconnected from prompt trace (only partly closed by tf-783y). | Open — link trace context across codec→edge→agent, or group metrics by `context.id` |
| Data-flow | **Output-read amplification** 1.2–2.6× (clean run vs accumulated). The residual re-walk `tf-aseo` (durable RuntimeContextStateTable) targets. | In progress (#633) |
| Watch | **Recurring `open_byte_pipe: local process command failed to start ×1`** in nearly every run. Possibly the **child session's agent subprocess** failing to spawn (would compound the parent→child gap). | Unverified — worth a drill (correlate with the child `session_new` context) |

Also: the **replay storm** (#612/tf-7kq8) was already fixed before this session; the first 157 MB
trace (one 140k-span trace) was a pre-fix capture.

---

## 4. PRs from this session

- **#638 — embedded durable-streams server on fixed `:4437` + registry hooks — MERGED.** Makes the
  host inspectable by the test-ui with zero config.
- **#637 — `schedule_me` non-blocking durable scheduler — open** (validated by #642).
- **#639 — ACP dev tooling — open** (`acp-tool-elicitation` sim + `tools/durable-streams-ui/` + the
  two investigation docs). CI fixes applied: eslint `no-production-js-timers` (→ `Effect.timeout`),
  semgrep `no-date-now`/`no-process-env` (removed), knip `lint:dead` (`ignoreWorkspaces` for the
  vendored UI). **Verify CI green before merge.**

---

## 5. Gotchas (cost us time — avoid)

- **Fixed `:4437` collision:** the embedded server now binds a *fixed* port. A Zed agent + the
  headless driver (each spawns `firegrid acp`) **collide on 4437**. Run one at a time, OR make the
  port env-configurable (recommended follow-up). The UI never collides (it only reads).
- **Append-mode trace mixing:** `rm .firegrid/acp-trace.jsonl` between captures, or use the sim's
  per-run files.
- **`git subtree` + `pull --rebase` = breakage:** vendoring durable-streams as a subtree on local
  `main`, then `ggpull` (rebase), replayed the squash commit's root files against the repo root →
  add/add conflicts. We abandoned the subtree; the UI is now a plain `tools/durable-streams-ui/`
  copy. **Don't rebase-pull unpushed subtree commits.**
- **Worktrees get pruned** by the multi-agent env mid-task — commit/push promptly; re-add with
  `git worktree add <path> <branch>`.
- **Lint rules to respect in sims:** no `Date.now()` (`firegrid-no-date-now` — use span durations
  or `Clock`), no `process.env` outside `bin/` (`firegrid-no-process-env-outside-bin`), no
  `setTimeout` in runtime (`local/no-production-js-timers` — use `Effect.timeout`), and vendored
  workspaces need `ignoreWorkspaces` in `knip.json`.

---

## 6. Next steps — tighten the loop with the build team

1. **Merge #639** (tooling) and **#637** (schedule_me) once CI is green — they unblock the loop.
2. **File the parent→child output channel gap** as a P-bead (host-declared `session.child.output`,
   keyed by the `session_new` handle, `wait_for`-able; not agent-predicted).
3. **Fix the two `acp-trace-health.py` metric artifacts** so reports stop misleading: define the
   tool-result span correctly (so `open` = real hangs), and distinguish fast tool errors from turn timeouts.
4. **Close the trace-linkage gap (§7.4):** propagate W3C trace context (or a `turnId` link attr)
   across codec→edge→agent so a turn's spans + the wire bytes share one trace. This is the highest-leverage
   instrumentation investment — it makes the axis-2 connectedness metric trustworthy. Until then,
   group fragmentation metrics by `context.id`, not `traceId`.
5. **Drill the `open_byte_pipe` transient** — correlate with the child `session_new` context to see
   if the child agent isn't spawning.
6. **Make `:4437` env-configurable** so the driver and a Zed agent coexist (and the sim/driver can
   run while you watch the UI).
7. **Build a fixture corpus + CI-gate the analyzer:** capture/commit representative traces, run
   `acp-trace-health.py` (and a deterministic in-process variant of the sim) against them in CI so
   regressions in connectedness/amplification are caught — keeping live-LLM capture out of the
   deterministic gate (env-gated, manual), per the established rule.

---

## 7. File index

| Concern | Path |
|---|---|
| Trace span schema / append mode | `packages/observability/src/node.ts:107`, `:133` |
| ACP stdio edge (permission handler, turn loop, 30s timeout) | `packages/host-sdk/src/host/acp-stdio-edge.ts` |
| Codec blocking `requestPermission` | `packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts:488` |
| Embedded server `:4437` + registry (merged #638) | `packages/cli/src/bin/run.ts` (`durableStreamsEndpoint`) |
| Trace-health report | `scripts/acp-trace-health.py` |
| Headless elicitation sim | `packages/tiny-firegrid/src/simulations/acp-tool-elicitation/` (PR #639) |
| Stream-inspector UI | `tools/durable-streams-ui/` (PR #639) |
| Permission-deadlock finding | `docs/investigations/2026-05-21-acp-stdio-edge-permission-deadlock.md` |
| Parent→child gap finding | `docs/investigations/2026-05-21-acp-parent-child-output-channel-gap.md` |
| `schedule_me` source-verify | `docs/research/tf-uoga-schedule-me-live-timeout.FINDING.md` |
