# FINDING — tf-7kq8: runtime-context output-observation replay storm (hotfix)

## Verdict

Live ACP tool-call turns hung because the runtime-context workflow's
output-discovery read re-executed a full output-table scan on **every**
`@effect/workflow` replay, re-walking the entire output history each resume —
O(resumes × history × rows). A live agent turn (many streamed output chunks →
many resumes) collapsed into an `agent_output.initial` storm and the ACP edge
timed out waiting for `TurnComplete`. This hotfix memoizes the immutable reads;
the quadratic re-walk is eliminated.

## Root cause (source-verified)

`runtime-context.ts` body driver `runMergedEventLoop`:

- `completedRuntimeOutput` → `events.initial(afterSequence)` is a **live,
  non-memoized full-table scan** (`per-context-output.ts:110-140`,
  `coll.toArray` linear select), and is the **only** loop op not wrapped as an
  `Activity` (siblings `startSessionActivity`/`sendSessionActivity`/
  `runToolUseActivity`/`transitionRuntimeContextEventActivity` are journaled).
- The merged-loop cursor lives in an **in-memory `Ref`** seeded
  `lastProcessedOutputSequence: -1`; it does not survive replay, so each resume
  re-walks from −1, re-running the live read for every sequence up to head.
- Each agent output chunk appends a row and drives a resume → another full
  re-walk → O(resumes × history × rows). `after_sequence` decay (−1 read 81×,
  … 106 read 17×) is the replay fingerprint.

Input observation does NOT have this problem: it rides a `DurableDeferred` +
`engine.deferredResult` (durable, journaled). Output had no equivalent.

## Fix (narrow bridge)

`initial(afterSequence)` is **immutable** (the min output with sequence >
afterSequence never changes once it exists). So memoize `Some` results in a
process-scoped `Ref<HashMap>` created once at workflow registration (survives
the in-process replays the engine drives) and threaded down the output path.
`None` (caught-up frontier) is never cached, so it re-polls live and still
observes new outputs. Re-walk → O(1) cache hits; real reads → O(distinct
outputs) + a small linear frontier-poll residual.

This is a deliberately narrow bridge. The full replay-safe **durable-await /
streaming** output consumer (no frontier polling at all) is the lane-2 target
(tf-ly2g / Phase 0B reference).

## Evidence (real `claude-agent-acp@0.36.1`, production codepath)

Sim `tf-7kq8-output-replay-storm` drives the real agent through
`FiregridLocalHostLive` + the production runtime-context workflow (no synthetic
agent). A/B is apples-to-apples (same agent, prompt, resume count, sequence
count); only `runtime-context.ts` differs (`origin/main` vs the fix).

Verbose text-only turn (isolates output streaming from the tool-call path):

| variant | resumes | output reads | distinct seq | **read ratio** | turn completed |
| --- | ---: | ---: | ---: | ---: | --- |
| main (no fix) | 35 | 129 | 42 | **3.1×** | yes (marker delivered) |
| **branch (fix)** | 35 | 51 | 42 | **1.2×** | yes (marker delivered) |

Tool-call turn — the live failure scenario: ask the real agent to call the
Firegrid `sleep` tool, with `session.permissions.autoApprove` (claude-agent-acp
gates tool calls behind `canUseTool`; without approval the call never reaches
the handler — that is why the first PR revision showed `McpServer.tools/call: 0`).

| variant | resumes | output reads | distinct seq | **read ratio** | round trip |
| --- | ---: | ---: | ---: | ---: | --- |
| main (no fix) | 28 | 47 | 13 | **3.6×** | completes |
| **branch (fix)** | 31 | 21 | 13 | **1.6×** | completes |

**Tool-call round trip on the fixed branch (the reviewer's acceptance bar):**

| span | count |
| --- | ---: |
| `McpServer.tools/list` | 2 |
| `McpServer.tools/call` | **1** |
| `Toolkit.handle` | **1** |
| `firegrid.host.agent_tools.tool_use.execute` (result) | **1** |
| agent terminal marker `FIREGRID_SLEEP_DONE` | observed |
| runner outcome | **DriverCompleted** |

So post-fix the Firegrid tool path completes end-to-end (`tools/call` →
`Toolkit.handle` → `tool_use.execute` → result → agent marker → DriverCompleted)
while output reads stay bounded. The independent `wait-pre-attach-roundtrip` sim
(claude `wait_for`) on the fixed branch reproduces the same: `tools/call: 1`,
`Toolkit.handle: 1`, `tool_use.execute: 1`, DriverCompleted, read ratio 1.4×.

The ratio is **size-dependent** (it's quadratic): tiny turn 3.1×, tool turn
7.0×, the original live Zed turn **74×** (7951 reads / ~107 outputs / 421
resumes — the actual hang). The fix flattens it to ~1.2–1.9× regardless of turn
size, so a turn that would hang at scale now stays O(outputs).

### Honest scope of this evidence

- ✅ Eliminates the **quadratic** re-walk amplification (the storm), validated
  with the real agent on production codepaths.
- ✅ The Firegrid tool-call round trip **completes** post-fix
  (`tools/call`/`Toolkit.handle`/`tool_use.execute` > 0, DriverCompleted).
- ⚠️ A small **linear** frontier-poll residual remains (~1.2–1.6×) — inherent to
  the polling design; removed only by the lane-2 durable-await consumer. This
  hotfix is explicitly temporary on the path to that durable cursor primitive.
- ⚠️ The sims complete within timeout at their (small) scale, so they show the
  amplification **ratio** drop, not a literal hang→complete transition; the hang
  is reproduced by the original live Zed trace at 74× (7951 reads).

## Gates

`@firegrid/runtime` + `firelab` typecheck; host-sdk
runtime-context-workflow-core + runtime-codec-event-plane tests (14) pass;
`lint` + `lint:dead` + `lint:dup` + `lint:deps` green; Effect-diag within
baseline.
