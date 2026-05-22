# ACP trace-health report (tf-7008)

**Date:** 2026-05-21
**Tool:** `scripts/acp-trace-health.py`
**Input:** the `--otel-file` JSONL dump from `firegrid acp`
(default `.firegrid/acp-trace.jsonl`)
**Purpose:** a reusable, dependency-light instrument for the live Zed/ACP
debugging loop. One command turns a raw span dump into a three-axis health
report so each live capture is triageable without re-deriving DuckDB queries.

This is the report companion to the two running investigations:
- `2026-05-21-acp-stdio-edge-permission-deadlock.md` (P0 permission drop)
- `2026-05-21-live-acp-tool-call-triage.md` (tf-7kq8 read-storm, tool matrix)

## Design stance: measure, don't conform

The report **does not assume today's architecture is correct.** Fragmented
traces, orphan spans, multiple roots per trace, and output-read amplification
are reported as *measured baselines*, not pass/fail against the current edge.
The `!!` markers flag "this is a number a fix should move," not "this is broken
relative to spec." The point is to surface loops, linkage gaps, and
amplification — and to let a later fix be scored against a recorded baseline.

## Usage

```bash
python3 scripts/acp-trace-health.py [PATH] [--json] [--top=N]
# PATH defaults to .firegrid/acp-trace.jsonl
# --json   machine-readable (CI gates, diffing two captures)
# --top=N  rows per ranked list (default 8)
```

Pure Python stdlib — no DuckDB, no `tsx`, no pip install. Runs anywhere
`python3` exists. (The DuckDB queries in the deadlock doc §2 remain valid for
ad-hoc deep dives; this script is the standing battery.)

> **Append-mode caveat:** the exporter opens the file with `flags: "a"`
> (`packages/observability/src/node.ts:133`), so one file can mix runs. The
> report is global but every section breaks down per-trace / per-context, which
> makes the mixing visible rather than hiding it. Delete the file between
> isolated captures.

## The three axes

### Axis 1 — bug signals (correctness)
- **error spans** — `status.code == 2`, with the `AcpStdioEdge` error `reason`
  parsed out (timeout vs. other).
- **interrupted spans** — `status.interrupted` / `span.label == "⚠︎ Interrupted"`
  (`session-agent-output.ts:43`); a turn that never reached `TurnComplete`.
- **in-flight spans** — spans with no end record. Zero today (end-only
  exporter); becomes meaningful once tf-9ia9 span-START records land, where an
  unmatched start = a genuinely open span (e.g. a hung `tools/call`).
- **permission round-trip** — `request / respond.call / response / wf.send`
  counts. Healthy gated call wants `request == response`.
- **tool-call balance** — `tools/call / Toolkit.handle / resolve / execute /
  acp.tool_result`; `open = tools/call − acp.tool_result` flags a call whose
  result never returned to the agent (the tf-7kq8 signature).

### Axis 2 — data-flow health (linkage / fragmentation)
- **spans-per-trace shape** — min/median/avg/p95/max + largest traces (storm
  detector: tiny median, huge max ⇒ one trace absorbing a loop).
- **traces with >1 root** — spans whose parent is absent from their own trace.
  Many roots in one trace = broken intra-trace linkage.
- **orphan spans** — parent set but absent from the whole file.
- **contexts split across traces** — one logical `firegrid.context.id` spread
  over N traces; the direct measurement behind deadlock-doc rec §7.4 (link the
  byte-stream trace to the prompt trace).
- **output-read amplification** — `initial reads / distinct output sequence`,
  plus the `after_sequence` decay histogram. `>1.0` = history re-read; the
  decay shape (earliest sequences read most) is the from-scratch-restart
  signature from tf-7kq8.

### Axis 3 — simplification hints (overhead / loops)
- **top ops by count** — chatter candidates (high count, low avg ms).
- **top ops by total wall ms** — where the wall budget actually goes.
- **duplicated parent→child stacks** — identical edges recurring far more than
  the logical work; candidates for collapsing.
- **ops missing context.id** — which op *types* lose linkage (not a bare total).

## Baseline capture — live claude-acp run, 2026-05-21

Against the live `.firegrid/acp-trace.jsonl` (6621 spans, post-#612 durable
cursor; **still contains a timed-out turn** — good adversarial baseline):

```
AXIS 1 - BUG SIGNALS
  !! error spans:            1   (acp_stdio_edge.prompt reason=timeout)
  !! interrupted spans:      83
  ok in-flight (no end):     0
  ok permission round-trip:  request=1 respond.call=1 response=1 wf.send=8
  !! tool-call balance:      tools/call=1 ... result=0   open=1

AXIS 2 - DATA-FLOW HEALTH
     distinct traces:        39
     spans/trace:            min=1 median=2.0 avg=169.8 p95=76.2 max=6194
  !! traces w/ >1 root:      1   (the 6194-span trace has 79 roots)
  !! orphan spans:           78  (session_update x49, execution.execute x17, ...)
  !! contexts split across traces: 1 of 1  (1 context over 13 traces)
     spans without context:  304
  !! output-read amplification: 1.33x  (76 reads / 57 distinct seq)

AXIS 3 - SIMPLIFICATION HINTS
     total spans / distinct op names: 6621 / 256
     top ops by count:   durable_table.get x1516, activity.execute x554, ...
     top ops by total ms: acp_stdio_edge.prompt 55335ms (3x), session_agent_output 55260ms (45x)
     dup stacks:         activity.execute -> durable_table.get x874
```

### What the baseline says (read alongside the two investigation docs)

1. **Trace linkage is currently poor — and now measured.** One context
   (`ctx_ext_…`) is spread over **13 traces**; the long-lived `byte_stream`
   pipe trace holds **6194 spans with 79 distinct roots**; **78 orphan spans**
   (dominated by `acp.session_update` ×49 — the agent wire events have no
   in-file parent). This is the quantified version of deadlock-doc §7.4 "the
   byte-stream trace and the per-turn prompt trace don't share a trace." A
   context-propagation fix should drive `contexts-split` → 1 and orphans → ~0.
2. **The timeout still reproduces.** `acp_stdio_edge.prompt reason=timeout` ×1
   and **83 interrupted spans**; `tools/call=1` but `acp.tool_result=0`
   (`open=1`) — the result never returned to the agent. Matches tf-7kq8.
3. **Permission round-trip is balanced 1:1 but `wf.send=8`** for a single
   request — the workflow re-emits the permission response 8× (replay
   re-execution echo). Request==response is healthy; the 8× send is an Axis-3
   amplification hint, not a correctness bug.
4. **Wall budget is dominated by the three timed-out prompts** (55s across 3
   `acp_stdio_edge.prompt`, mirrored by 45× `session_agent_output` long-polls)
   — i.e. the wall cost here is *waiting*, not compute. `activity.execute`
   (554×) is 2.7s total: the engine itself is cheap; the hang is upstream.
5. **Read amplification is down to 1.33×** (was ~80× pre-#612). The standing
   Axis-2 number to watch for a tf-7kq8 / tf-aseo regression; the
   `after_sequence` decay is now shallow (mostly ×1), not the ×81→×17 decay of
   the storm.

## Suggested loop integration

- Run after each live Zed capture; diff `--json` between two captures to score a
  fix (e.g. orphan count, `contexts-split`, `read_amplification`, `open`).
- A regression gate could assert ceilings on `read_amplification`,
  `spans_per_trace.max`, and `open_tool_calls` (deadlock-doc §7.8 storm gate).
