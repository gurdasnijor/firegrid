# Live ACP tool-call triage — running doc (2026-05-21)

**Purpose.** Track issues found while exercising the Firegrid runtime-context
MCP tools through a live editor (Zed) over the ACP stdio edge, tool by tool.
Cite trace spans as evidence so each issue is triageable and fixable.

**Owner:** ongoing. **Started:** 2026-05-21.

## Setup under test

- **Edge:** `firegrid acp` (merged tf-r1gz CLI), launched by Zed via
  `bash -lc 'cd /Users/gnijor/gurdasnijor/firegrid && pnpm --silent exec tsx
  packages/cli/src/bin/run.ts -- acp --agent <agent> --agent-protocol acp
  --secret-env <KEY> --otel-file .firegrid/acp-trace.jsonl -- npx -y <agent-pkg>'`
- **Trace artifact:** `/Users/gnijor/gurdasnijor/firegrid/.firegrid/acp-trace.jsonl`
  (JSONL, one span per line; immediate per-span flush via tf-r1gz
  `SimpleSpanProcessor`). NOTE: append-mode — multiple sessions accumulate;
  isolate by `traceId` / `contextId` when reading.
- **Agents tried:** `@zed-industries/codex-acp@0.14.0` (codex),
  `@agentclientprotocol/claude-agent-acp@0.36.1` (claude).
- **MCP surface:** runtime-context server on `127.0.0.1:<ephemeral>` at
  `/mcp/runtime-context/:contextId`. 11 tools (`register_toolkit` span):
  `call, execute, schedule_me, send, session_cancel, session_close,
  session_new, session_prompt, sleep, wait_for, wait_for_any`.

### Reading the trace (handy commands)

```bash
F=.firegrid/acp-trace.jsonl
# span-name histogram
node -e 'const fs=require("fs");const c={};for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n")){if(!l.trim())continue;try{c[JSON.parse(l).name]=(c[JSON.parse(l).name]||0)+1}catch{}}for(const k of Object.keys(c).sort())console.log(String(c[k]).padStart(5),k)' "$F"
# is it still growing (live hang)?
a=$(wc -l < "$F"); sleep 2; b=$(wc -l < "$F"); echo "$a -> $b"
```

## Status summary

| Layer | Status | Evidence |
| --- | --- | --- |
| MCP server itself (substrate) | ✅ healthy | external MCP client probe: `tools/list`→11, `tools/call sleep`→`{"slept":true}` |
| Tool **enumeration** — claude | ✅ works | live Zed: lists all 11 tools; `McpServer.tools/list` present |
| Tool **enumeration** — codex | ❌ broken (known) | `McpServer.tools/list = 0` every run; documented G-MCP-2 non-enumerating (`docs/research/tf-p9s-s6-agent-runtime-config.FINDING.md:53`) |
| Tool **invocation** round-trip | ❌ hangs | `tf-7kq8` — output-observer re-subscription storm; result never returns; edge turn times out |

## Issues

### ISSUE-1 (tf-7kq8, P1) — live tool-call hangs: agent-output observer re-subscribes ~2000×; result never returns

**Symptom.** claude issues a real `sleep` tool call; the turn never completes;
edge fails with:

```json
{ "_tag": "AcpStdioEdgeTurnOutputError", "reason": "timeout",
  "message": "timed out waiting for Firegrid agent output" }
```

**Trace evidence** (`.firegrid/acp-trace.jsonl`, live claude run 2026-05-21 ~15:49):

| Span | Count | Reading |
| --- | ---: | --- |
| `firegrid.runtime_output.per_context.agent_output.initial` | **1987** | observer re-reads output from sequence 0 repeatedly (replay storm) — should be incremental |
| `firegrid.runtime_context.workflow.output.completed` | ~1947 | output reprocessed each re-subscription |
| `firegrid.runtime_context.workflow.event.handle` | ~1947 | matching event churn |
| `firegrid.workflow_engine.activity.execute` | ~2028 | activity storm |
| `firegrid.runtime-context.state…output.N.after` (N=0..8) | repeated | same output sequence window replayed |
| `McpServer.tools/call` (completed) | **0** | the `sleep` call span never closed |
| `firegrid.agent_event_pipeline.acp.tool_result` | **0** | tool result never propagated back to the agent |

**Localization (from trace, not yet source-verified).** The per-context
agent-output observer appears to read `agent_output.initial` (from the start)
on each workflow resume/event instead of reading incrementally after the last
observed sequence, producing an O(history) reprocessing loop that never
converges. The tool result therefore never reaches the codec → the agent never
emits TurnComplete → the edge's 30s `turnTimeoutMs` fires.

**Update 2026-05-21 ~15:55 — second turn (`sleep` durationMs 3000) confirms + sharpens:**

- **`durationMs: 0` is RULED OUT.** `sleep 3000` hangs identically (same
  timeout error). The bug is tool-arg-independent.
- **Exact 1:1 self-feeding loop.** Cumulative counts after the 3000ms turn:
  `agent_output.initial = 2500` **==** `workflow.output.completed = 2500`.
  The 1:1 equality is the signature: each completed output triggers one fresh
  observer re-subscription from sequence 0, which re-reads the output history
  and produces another completed output → another re-subscription. Self-feeding;
  never converges.
- **Loop sits UPSTREAM of the tool's durable execution.** Still
  `McpServer.tools/call` completed `= 0`, `acp.tool_result = 0`, **and no
  `clock`/`sleep`/`timer`/`ClockWakeup`-named span at all** — i.e. the durable
  sleep is never observed to run; the storm is in the output-observation /
  result-return path, not in tool execution itself.

**Refined hypothesis:** the agent-output observer is (re)created per
output.completed and seeds from `initial` (sequence 0) rather than resuming
after its last delivered sequence; delivering an output re-triggers creation,
closing the loop. Fix likely = make the per-context agent-output observer
resume from the last-observed sequence (incremental) and/or be created once per
turn, not per output event.

**Update 2 — `after_sequence` distribution proves re-read amplification (not a producer loop).**
Across the `agent_output.initial` spans: `after_sequence` spans −1 → 106 (≈107
real output sequences), but **each sequence is re-queried ~80×** (`initial(-1)`
81×, `initial(0)` 81×, `initial(1)` 80× … decaying to 17× for the most-recent
sequences). 107 outputs × ~80 re-reads ≈ 2642 `initial` spans. The **decay**
(earliest sequences re-read the most) is the signature of an **observer that
restarts ~80 times and replays history from the start each time** — i.e. it
seeds from `initial` instead of resuming `after` its last-delivered sequence.

**Source localization (verified by grep):**
- `packages/runtime/src/agent-event-pipeline/authorities/per-context-output.ts`
  exposes both `initial` (single next output *from a from-scratch table read*,
  span `…agent_output.initial`, L147) and `after` (incremental stream, span
  `…agent_output.after`, L156/171). The trace shows ~2642 `initial` and the
  `after` stream is not carrying the load → the consumer is re-entering
  `initial` on each restart.
- Consumers of `initial`: `packages/runtime/src/workflow-engine/workflows/runtime-context.ts:281`
  (`events.initial(runtimeOutputAfterSource(...))` inside the workflow body) and
  `packages/runtime/src/streams/runtime-observation-streams.ts:103`
  (`service.initial(source)`). Each workflow body **resume** re-runs `initial`
  from its checkpointed `afterSequence`; if the resume cadence is high and the
  position isn't advanced/streamed, this re-reads history repeatedly.

**Suggested fix direction (for tf-7kq8):** have the runtime-context output
consumer hold an incremental `after(lastSequence)` stream for the life of the
turn (advancing `afterSequence` as outputs are delivered) instead of
re-entering `initial(...)` on each workflow resume — so output delivery is
O(outputs), not O(resumes × history), and the terminal output reaches the edge.

### CORRECTION + root cause (2026-05-21 ~16:10, source-read)

Two earlier claims in this issue were **wrong** and are corrected here:

1. ~~"the tool ran but the result never returned"~~ — **No evidence the tool
   executed.** In the hung live runs: `McpServer.tools/call`, `Toolkit.handle`,
   `firegrid.mcp.runtime_context.resolve`, `firegrid.host.agent_tools.tool_use.execute`
   are all **0**. (`runtime_context.resolve` fires-and-closes *early* in the
   handler, before the blocking workflow run — its absence means no tool call
   reached the handler body.) Confirmed **tool-independent**: `sleep` (0ms and
   3000ms) and `execute` all hang identically.
2. The dominant, end-visible pathology is the **runtime-context workflow output
   read storm**, and it appears to **block the turn from progressing at all** —
   so the agent likely never issues the MCP tool call; the edge times out
   waiting for `TurnComplete`.

**How tool calls actually flow (verified: `toolkit-layer.ts:58` + the SUCCESSFUL
`wait-pre-attach` sim trace):** MCP `tools/call` → `Toolkit.handle` →
`handleTool` resolves the route context, mints `toolUseId`, runs a
`ToolCallWorkflow` on the runtime-context engine and **blocks on a host-owned
deferred**; the tool lowers to runtime behavior (`sleep`→`DurableClock.sleep`,
etc.) as a workflow activity; the deferred resolves → handler returns →
`tools/call` HTTP response. The result returns as the **MCP response**, not via
the agent-output stream. Span trail (sim): `mcp.http POST` → `McpServer.tools/call`
→ `Toolkit.handle` → `mcp.runtime_context.resolve` → `runtime_context.input.append_intent`
→ `runtime_input.deferred.append` → … → `workflow_engine.deferred.result`/`done`.

**Root-cause localization (source).** `runtime-context.ts:274` `completedRuntimeOutput`
wraps `events.initial(afterSequence=state.lastProcessedOutputSequence)`
(span = `…workflow.output.completed`) and is called per body step (L762). This
is a **live, non-memoized DurableTable read inside the durable workflow body**,
so it **re-executes on every `@effect/workflow` replay/resume**. Each resume
re-reads outputs from the current `afterSequence`; across a long agent turn
(~107 outputs, ~80 resumes) this is O(resumes × history) — exactly the
`after_sequence` decay (−1 read 81×, … 106 read 17×). The terminal output never
gets delivered cleanly within the edge's 30s `turnTimeoutMs`.

**Open question (needs in-flight spans, tf-9ia9):** is the agent *blocked
mid-`tools/call`* (handler span open, not exported) or *never issuing it*? The
end-only exporter can't tell. `runtime_context.resolve = 0` leans toward
"never issued / turn never progressed," but tf-9ia9 start-records would make it
definitive.

**Refined fix direction:** the runtime-context body should not re-run live
output reads on every replay. Options: (a) make output observation a single
durable streaming consumer that advances `afterSequence` once per delivered
output (O(outputs)); (b) memoize the read as an activity result so replay
doesn't re-execute it; (c) restructure the reactive body so output egress is
not on the replay path. Confirm against `@effect/workflow` replay semantics.

### SOURCE-VERIFIED root cause (2026-05-21 ~16:25) — pinned to lines

Read the full body driver `runMergedEventLoop` (`runtime-context.ts:815-845`):

```
820  const stateRef = yield* Ref.make(initialRuntimeContextEventState)  // in-memory Ref
822  while (shouldContinue) {
823    const state = yield* Ref.get(stateRef)
824    const completed = yield* completedRuntimeContextEvent(...)  // events.initial — LIVE read
827      : yield* awaitNextRuntimeContextEvent(...)                // DurableDeferred.await => suspend/resume
828    shouldContinue = yield* handleRuntimeContextEvent(...)       // transition = Activity (memoized)
  }
```

Three verified facts ⇒ O(replays × history × rows) on the workflow replay path:

1. **The output-discovery read is the only loop op NOT wrapped as an `Activity`.**
   Siblings are activities (memoized on replay): `startSessionActivity` (L139),
   `sendSessionActivity` (L167), `runToolUseActivity` (L395),
   `transitionRuntimeContextEventActivity` (L695). But the output read
   `completedRuntimeContextEvent` (L749) → `completedRuntimeOutput` (L762) →
   `events.initial` (L281) is a **plain live Effect** → re-executes every replay.
2. **Loop state is an in-memory `Ref` (L820)** seeded `initial`
   (`lastProcessedOutputSequence: -1`, L349). The `Ref` does not survive replay,
   so each resume re-walks the loop from sequence −1, re-running the live read
   for every sequence up to the current head. (`handleRuntimeContextEvent`'s
   transition is memoized, so it's cheap — only the read re-runs hot.)
3. **`events.initial` is a full output-table scan** (`table.events.rows()`
   reduced to min sequence > afterSequence, `per-context-output.ts:110-140`).

Resume cadence: every agent output chunk appends an output row; the body is
parked in `awaitNextRuntimeContextEvent` → `DurableDeferred.await`
(`runtime-context.ts:210`), so each new row resumes the workflow → another full
re-walk. A real agent turn (~107 output chunks → ~80 resumes) ⇒ the `agent_output.initial`
re-read storm and `after_sequence` decay (−1 ×81 … 106 ×17). Short turns stayed
cheap (few resumes), which is why this hid until a live multi-chunk turn.

**Status: tf-7kq8 root cause is source-verified.** Fix is now a design choice
among (a)/(b)/(c) above; (a) — a single replay-safe streaming output consumer —
is the one that matches the SDD's "output observation is replay-safe / O(outputs)"
target.

**Not caused by:** the agent (claude *does* call tools; codex is a separate
non-enumeration issue), the Zed config, or the tf-r1gz observability changes
(exporter-only).

**Related seams:** `tf-9sx9` (tiny-firegrid observer-leak removal), the A4
output-stream correctness seam.

**Repro:** `firegrid acp --agent claude-acp --agent-protocol acp -- npx -y
@agentclientprotocol/claude-agent-acp@0.36.1`; prompt "sleep 0ms using your
Firegrid tool".

### ISSUE-2 (documented, not a regression) — codex-acp@0.14.0 is non-enumerating

codex never issues `McpServer.tools/list` over ACP (`= 0` across all
`codex-acp-tool-calls` sim runs 5/19–5/21), so it can't surface or call the
Firegrid MCP tools. Documented: `docs/research/tf-p9s-s6-agent-runtime-config.FINDING.md:53`
("G-MCP-2-verified non-enumerating … cannot call MCP tools at all"). Mitigation:
use claude-agent-acp over ACP, or codex via the stdio-jsonl/`codex exec` path
(`tf-taba`) where the MCP server is configured through codex's own
`mcp_servers` config and it does enumerate.

## Tool-by-tool test matrix

Agent: claude-agent-acp@0.36.1 over ACP unless noted. Fill in as we test.

| Tool | Prompt used | Outcome | Trace evidence |
| --- | --- | --- | --- |
| `sleep` | "sleep 0ms using your Firegrid tool" | ❌ HANG → edge timeout | ISSUE-1 / tf-7kq8 (`agent_output.initial` ×1987) |
| `sleep` | "sleep for 3000 ms, reply DONE" | ❌ HANG → edge timeout (durationMs ruled out) | ISSUE-1 / tf-7kq8 (`agent_output.initial` == `output.completed` == 2500; no clock span; `tools/call` 0) |
| `execute` | "help debug … /docs/investigations/…triage.md" (agent chose `execute`) | ❌ HANG → edge timeout | ISSUE-1 / tf-7kq8 — confirms **tool-independent**; no `tools/call`/`Toolkit.handle`/`tool_use.execute` end-spans |
| `session_new` | _untested_ | | |
| `session_prompt` | _untested_ | | |
| `session_cancel` | _untested_ | | |
| `session_close` | _untested_ | | |
| `call` | _untested_ | | |
| `send` | _untested_ | | |
| `wait_for` | _untested_ | | |
| `wait_for_any` | _untested_ | | |
| `execute` | _untested_ | | |
| `schedule_me` | _untested_ | | |

> Note: `wait_for` *did* complete in the `wait-pre-attach-roundtrip` sim
> (`McpServer.tools/call = 1`, `DriverCompleted`) against a pre-seeded fact —
> so the hang in ISSUE-1 may be specific to tool families whose result flows
> back through the agent-output path (e.g. `sleep`) vs. ingress-matching tools
> (`wait_for`). Worth confirming in the matrix.

## Open beads

- `tf-7kq8` (P1 bug) — ISSUE-1 output-observer re-subscription loop.
- `tf-9ia9` (P1) — span-START records for live in-flight visibility (lower
  priority; the sim's completed trace already localized ISSUE-1).
- `tf-3718` (P3) — fail-loud if `--otel-file` dir unwritable (tf-r1gz follow-on).
