#!/usr/bin/env python3
"""ACP trace-health report over a Firegrid `--otel-file` JSONL dump.

Reads the per-span JSONL written by `@firegrid/observability`'s
`JsonlFileSpanExporter` (one OTel span per line; see
`packages/observability/src/node.ts:107`) and emits a health report across
three axes:

  Axis 1 — BUG SIGNALS (correctness):
      errors / timeouts, interrupted spans, permission round-trip ratios,
      open / unbalanced tool-call spans.
  Axis 2 — DATA-FLOW HEALTH (linkage):
      spans-per-trace shape, roots per trace, orphan spans, context/turn
      fragmentation across traces, output-read amplification, after_sequence
      health.
  Axis 3 — SIMPLIFICATION HINTS (overhead):
      replay/read loops, missing context propagation, duplicated parent->child
      stacks, per-op count + wall overhead.

Design intent (tf-7008): this is a *measurement* instrument, not a conformance
check. It does NOT assume today's architecture is correct. Fragmented traces,
orphan spans, and read amplification are reported as measured baselines so a
later fix can be scored against them — a "healthy" number here is whatever the
team decides, not what the current edge happens to produce.

Pure stdlib (json only). Usage:
    python3 scripts/acp-trace-health.py [PATH] [--json] [--top N] [--quiet]
PATH defaults to .firegrid/acp-trace.jsonl.

NOTE: the exporter opens the file in append mode, so a single file can mix
multiple sessions/runs. The report is global by default; per-trace and
per-context breakdowns make the mixing visible rather than hiding it.
"""

from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict


# ---------------------------------------------------------------------------
# Span model + loading
# ---------------------------------------------------------------------------

def _hr_to_ms(hr):
    """[seconds, nanoseconds] hrtime pair -> float milliseconds."""
    if not hr or not isinstance(hr, list) or len(hr) != 2:
        return None
    return hr[0] * 1000.0 + hr[1] / 1e6


class Span:
    __slots__ = (
        "name", "trace_id", "span_id", "parent_id", "kind",
        "start_ms", "end_ms", "dur_ms", "status_code", "status_msg",
        "role", "context_id", "attrs",
    )

    def __init__(self, raw):
        self.name = raw.get("name")
        self.trace_id = raw.get("traceId")
        self.span_id = raw.get("spanId")
        self.parent_id = raw.get("parentSpanId")
        self.kind = raw.get("kind")
        self.start_ms = _hr_to_ms(raw.get("startTime"))
        self.end_ms = _hr_to_ms(raw.get("endTime"))
        self.dur_ms = _hr_to_ms(raw.get("duration"))
        status = raw.get("status") or {}
        self.status_code = status.get("code")
        self.status_msg = status.get("message")
        self.attrs = raw.get("attributes") or {}
        self.role = (raw.get("resource") or {}).get("firegrid.process.role")
        self.context_id = self.attrs.get("firegrid.context.id")

    @property
    def in_flight(self):
        # No end record -> either an exporter span-start record (tf-9ia9) or a
        # truly unfinished span. Either way it never closed in this capture.
        return self.end_ms is None


def load(path):
    spans, bad = [], 0
    with open(path, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                spans.append(Span(json.loads(line)))
            except Exception:
                bad += 1
    return spans, bad


# ---------------------------------------------------------------------------
# small stats helpers
# ---------------------------------------------------------------------------

def _quantile(sorted_vals, q):
    if not sorted_vals:
        return 0
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    pos = q * (len(sorted_vals) - 1)
    lo = int(pos)
    hi = min(lo + 1, len(sorted_vals) - 1)
    frac = pos - lo
    return sorted_vals[lo] * (1 - frac) + sorted_vals[hi] * frac


def _shape(values):
    vals = sorted(values)
    if not vals:
        return {"n": 0, "min": 0, "max": 0, "avg": 0, "median": 0, "p95": 0}
    return {
        "n": len(vals),
        "min": vals[0],
        "max": vals[-1],
        "avg": round(sum(vals) / len(vals), 1),
        "median": round(_quantile(vals, 0.5), 1),
        "p95": round(_quantile(vals, 0.95), 1),
    }


# ---------------------------------------------------------------------------
# AXIS 1 — bug signals
# ---------------------------------------------------------------------------

# Span names that should appear in matched groups for a healthy gated tool call.
PERM_REQUEST = "firegrid.agent_event_pipeline.acp.permission_request"
PERM_RESPOND_CALL = "firegrid.channel.host.permissions.respond.call"
PERM_RESPONSE = "firegrid.agent_event_pipeline.acp.permission_response"
PERM_WF_SEND = "firegrid.runtime_context.workflow.permission_response.send"

TOOL_CALL = "McpServer.tools/call"
TOOL_HANDLE = "Toolkit.handle"
TOOL_RESOLVE = "firegrid.mcp.runtime_context.resolve"
TOOL_EXECUTE = "firegrid.host.agent_tools.tool_use.execute"
TOOL_RESULT = "firegrid.agent_event_pipeline.acp.tool_result"


def axis1_bugs(spans, top):
    by_name = Counter(s.name for s in spans)

    errors = [s for s in spans if s.status_code == 2]
    interrupted = [s for s in spans if s.attrs.get("status.interrupted")
                   or s.attrs.get("span.label") == "⚠︎ Interrupted"]
    in_flight = [s for s in spans if s.in_flight]

    # timeout breakdown by reason / tag (parse the AcpStdioEdge error message)
    timeout_reasons = Counter()
    for s in errors:
        reason = None
        if s.status_msg:
            try:
                reason = json.loads(s.status_msg).get("reason")
            except Exception:
                reason = s.status_msg[:60]
        timeout_reasons[(s.name, reason)] += 1

    perm = {
        "request": by_name.get(PERM_REQUEST, 0),
        "respond_call": by_name.get(PERM_RESPOND_CALL, 0),
        "response": by_name.get(PERM_RESPONSE, 0),
        "wf_send": by_name.get(PERM_WF_SEND, 0),
    }
    perm_balanced = perm["request"] == perm["response"]

    tools = {
        "tools/call": by_name.get(TOOL_CALL, 0),
        "Toolkit.handle": by_name.get(TOOL_HANDLE, 0),
        "runtime_context.resolve": by_name.get(TOOL_RESOLVE, 0),
        "tool_use.execute": by_name.get(TOOL_EXECUTE, 0),
        "acp.tool_result": by_name.get(TOOL_RESULT, 0),
    }
    # Unanswered tool calls: more handler entries than results returned.
    open_tool_calls = max(0, tools["tools/call"] - tools["acp.tool_result"])

    return {
        "errors": [
            {"name": s.name, "reason": (json.loads(s.status_msg).get("reason")
              if s.status_msg and s.status_msg.startswith("{") else s.status_msg),
             "dur_ms": round(s.dur_ms or 0)} for s in errors[:top]
        ],
        "error_count": len(errors),
        "timeout_reasons": [
            {"name": n, "reason": r, "count": c}
            for (n, r), c in timeout_reasons.most_common(top)
        ],
        "interrupted_count": len(interrupted),
        "in_flight_count": len(in_flight),
        "in_flight_names": [{"name": n, "count": c}
                            for n, c in Counter(s.name for s in in_flight).most_common(top)],
        "permission": perm,
        "permission_balanced": perm_balanced,
        "tools": tools,
        "open_tool_calls": open_tool_calls,
    }


# ---------------------------------------------------------------------------
# AXIS 2 — data-flow health
# ---------------------------------------------------------------------------

def axis2_dataflow(spans, top):
    ids = {s.span_id for s in spans}

    per_trace = defaultdict(list)
    for s in spans:
        per_trace[s.trace_id].append(s)

    trace_sizes = [len(v) for v in per_trace.values()]

    # roots per trace = spans with no parent, or whose parent is absent from the
    # *same* trace (a broken/cross-trace link presents as an extra root).
    roots_per_trace = {}
    for tid, ss in per_trace.items():
        local_ids = {s.span_id for s in ss}
        roots = [s for s in ss if not s.parent_id or s.parent_id not in local_ids]
        roots_per_trace[tid] = len(roots)
    multi_root = {t: n for t, n in roots_per_trace.items() if n > 1}

    # orphan spans: parent set but absent from the entire file.
    orphans = [s for s in spans if s.parent_id and s.parent_id not in ids]

    # context/turn fragmentation: a single logical context spread across traces.
    ctx_traces = defaultdict(set)
    for s in spans:
        if s.context_id:
            ctx_traces[s.context_id].add(s.trace_id)
    fragmented_ctx = {c: len(t) for c, t in ctx_traces.items() if len(t) > 1}

    no_context = sum(1 for s in spans if not s.context_id)

    # output-read amplification:
    #   how many times each output sequence was (re)read by the per-context
    #   output-discovery read. after_sequence -1 == "from scratch".
    output_initial = [s for s in spans
                      if s.name == "firegrid.runtime_output.per_context.agent_output.initial"]
    after_seq = Counter()
    for s in output_initial:
        v = s.attrs.get("firegrid.runtime.output.after_sequence")
        if v is not None:
            after_seq[v] += 1
    distinct_after = len(after_seq)
    amplification = (len(output_initial) / distinct_after) if distinct_after else 0.0
    # decay signature: earliest sequences re-read most => from-scratch restarts.
    after_decay = sorted(after_seq.items(), key=lambda kv: (kv[0] if isinstance(kv[0], (int, float)) else 0))

    output_completed = sum(1 for s in spans
                           if s.name == "firegrid.runtime_context.workflow.output.completed")

    return {
        "distinct_traces": len(per_trace),
        "spans_per_trace": _shape(trace_sizes),
        "largest_traces": [
            {"trace": t[:12], "spans": n}
            for t, n in sorted(((t, len(v)) for t, v in per_trace.items()),
                               key=lambda kv: -kv[1])[:top]
        ],
        "multi_root_traces": len(multi_root),
        "multi_root_sample": [
            {"trace": t[:12], "roots": n}
            for t, n in sorted(multi_root.items(), key=lambda kv: -kv[1])[:top]
        ],
        "orphan_spans": len(orphans),
        "orphan_names": [{"name": n, "count": c}
                         for n, c in Counter(s.name for s in orphans).most_common(top)],
        "distinct_contexts": len(ctx_traces),
        "fragmented_contexts": len(fragmented_ctx),
        "fragmented_sample": [
            {"context": c[-24:], "traces": n}
            for c, n in sorted(fragmented_ctx.items(), key=lambda kv: -kv[1])[:top]
        ],
        "spans_without_context": no_context,
        "output_initial_reads": len(output_initial),
        "output_completed": output_completed,
        "distinct_output_sequences": distinct_after,
        "read_amplification": round(amplification, 2),
        "after_sequence_decay": [
            {"after_sequence": k, "reads": v} for k, v in after_decay[:top]
        ],
    }


# ---------------------------------------------------------------------------
# AXIS 3 — simplification hints
# ---------------------------------------------------------------------------

def axis3_simplification(spans, top):
    by_name = Counter(s.name for s in spans)
    total = len(spans)

    # per-op overhead: count + total/avg wall time. High count + low avg = chatter
    # worth collapsing; high total = where the wall budget goes.
    op_stats = {}
    for s in spans:
        st = op_stats.setdefault(s.name, {"count": 0, "total_ms": 0.0})
        st["count"] += 1
        st["total_ms"] += s.dur_ms or 0.0
    per_op = sorted(
        ({"name": n, "count": v["count"],
          "total_ms": round(v["total_ms"]),
          "avg_ms": round(v["total_ms"] / v["count"], 2)}
         for n, v in op_stats.items()),
        key=lambda d: -d["count"],
    )

    # loop / amplification candidates: span names whose count vastly exceeds the
    # number of logical units they should track. We use distinct output sequences
    # and distinct input sequences as denominators where the name relates.
    distinct_out = len({s.attrs.get("firegrid.runtime.output.sequence")
                        for s in spans if s.attrs.get("firegrid.runtime.output.sequence") is not None})
    distinct_in = len({s.attrs.get("firegrid.input.sequence")
                       for s in spans if s.attrs.get("firegrid.input.sequence") is not None})

    # Heaviest repeated parent->child stacks: identical (parent_name -> child_name)
    # edges recurring far more than the logical work suggests = duplicated stack.
    name_by_id = {s.span_id: s.name for s in spans}
    edges = Counter()
    for s in spans:
        if s.parent_id and s.parent_id in name_by_id:
            edges[(name_by_id[s.parent_id], s.name)] += 1

    # missing context propagation: spans lacking context.id, grouped by name, so
    # we can see WHICH op type loses the linkage rather than a bare total.
    missing_ctx_by_name = Counter(s.name for s in spans if not s.context_id)

    return {
        "total_spans": total,
        "distinct_op_names": len(by_name),
        "distinct_output_sequences": distinct_out,
        "distinct_input_sequences": distinct_in,
        "top_ops_by_count": per_op[:top],
        "top_ops_by_total_ms": sorted(per_op, key=lambda d: -d["total_ms"])[:top],
        "duplicated_stacks": [
            {"edge": f"{p} -> {c}", "count": n}
            for (p, c), n in edges.most_common(top)
        ],
        "missing_context_by_name": [
            {"name": n, "count": c} for n, c in missing_ctx_by_name.most_common(top)
        ],
    }


# ---------------------------------------------------------------------------
# rendering
# ---------------------------------------------------------------------------

def _flag(ok):
    return "ok " if ok else "!! "


def render(report):
    a1, a2, a3 = report["axis1"], report["axis2"], report["axis3"]
    L = []
    p = L.append

    p("=" * 78)
    p("ACP TRACE-HEALTH REPORT  (tf-7008)")
    p(f"  file:           {report['path']}")
    p(f"  spans:          {report['span_count']}  (unparseable lines: {report['bad_lines']})")
    p(f"  roles:          {', '.join(report['roles']) or '(none)'}")
    p("  NOTE: append-mode file may mix runs; per-trace/context breakdowns below.")
    p("=" * 78)

    # ---- Axis 1 ----
    p("")
    p("AXIS 1 - BUG SIGNALS (correctness)")
    p("-" * 78)
    p(f"  {_flag(a1['error_count'] == 0)}error spans:            {a1['error_count']}")
    for e in a1["timeout_reasons"]:
        p(f"        - {e['name']}  reason={e['reason']}  x{e['count']}")
    p(f"  {_flag(a1['interrupted_count'] == 0)}interrupted spans:      {a1['interrupted_count']}")
    p(f"  {_flag(a1['in_flight_count'] == 0)}in-flight (no end):     {a1['in_flight_count']}")
    for n in a1["in_flight_names"]:
        p(f"        - {n['name']}  x{n['count']}")
    perm = a1["permission"]
    p(f"  {_flag(a1['permission_balanced'])}permission round-trip:  "
      f"request={perm['request']} respond.call={perm['respond_call']} "
      f"response={perm['response']} wf.send={perm['wf_send']}  "
      f"(want request==response)")
    t = a1["tools"]
    p(f"  {_flag(a1['open_tool_calls'] == 0)}tool-call balance:      "
      f"tools/call={t['tools/call']} handle={t['Toolkit.handle']} "
      f"resolve={t['runtime_context.resolve']} execute={t['tool_use.execute']} "
      f"result={t['acp.tool_result']}")
    p(f"        open (call - result) = {a1['open_tool_calls']}")

    # ---- Axis 2 ----
    p("")
    p("AXIS 2 - DATA-FLOW HEALTH (linkage / fragmentation)")
    p("-" * 78)
    s = a2["spans_per_trace"]
    p(f"     distinct traces:        {a2['distinct_traces']}")
    p(f"     spans/trace:            min={s['min']} median={s['median']} "
      f"avg={s['avg']} p95={s['p95']} max={s['max']}")
    for lt in a2["largest_traces"]:
        p(f"        - {lt['trace']}..  {lt['spans']} spans")
    p(f"  {_flag(a2['multi_root_traces'] == 0)}traces w/ >1 root:      {a2['multi_root_traces']}")
    for mr in a2["multi_root_sample"]:
        p(f"        - {mr['trace']}..  {mr['roots']} roots")
    p(f"  {_flag(a2['orphan_spans'] == 0)}orphan spans (parent absent): {a2['orphan_spans']}")
    for o in a2["orphan_names"]:
        p(f"        - {o['name']}  x{o['count']}")
    p(f"  {_flag(a2['fragmented_contexts'] == 0)}contexts split across traces: "
      f"{a2['fragmented_contexts']} of {a2['distinct_contexts']}")
    for fc in a2["fragmented_sample"]:
        p(f"        - ..{fc['context']}  spans {fc['traces']} traces")
    p(f"     spans without context: {a2['spans_without_context']}")
    p(f"  {_flag(a2['read_amplification'] <= 1.0)}output-read amplification: "
      f"{a2['read_amplification']}x  "
      f"(initial reads {a2['output_initial_reads']} / distinct seq "
      f"{a2['distinct_output_sequences']}; completed {a2['output_completed']})")
    if a2["after_sequence_decay"]:
        head = a2["after_sequence_decay"]
        p("        after_sequence reads (decay = from-scratch restarts):")
        p("        " + "  ".join(f"[{d['after_sequence']}]x{d['reads']}" for d in head))

    # ---- Axis 3 ----
    p("")
    p("AXIS 3 - SIMPLIFICATION HINTS (overhead / loops)")
    p("-" * 78)
    p(f"     total spans / distinct op names: {a3['total_spans']} / {a3['distinct_op_names']}")
    p(f"     distinct output seq / input seq: "
      f"{a3['distinct_output_sequences']} / {a3['distinct_input_sequences']}")
    p("     top ops by count (chatter candidates):")
    for o in a3["top_ops_by_count"]:
        p(f"        {o['count']:>6}  avg {o['avg_ms']:>7}ms  {o['name']}")
    p("     top ops by total wall ms (budget):")
    for o in a3["top_ops_by_total_ms"]:
        p(f"        {o['total_ms']:>8}ms  ({o['count']}x)  {o['name']}")
    p("     duplicated parent->child stacks:")
    for d in a3["duplicated_stacks"]:
        p(f"        {d['count']:>6}  {d['edge']}")
    if a3["missing_context_by_name"]:
        p("     ops missing context.id (linkage gaps):")
        for m in a3["missing_context_by_name"]:
            p(f"        {m['count']:>6}  {m['name']}")
    p("=" * 78)
    return "\n".join(L)


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    flags = {a for a in argv[1:] if a.startswith("--")}
    path = args[0] if args else ".firegrid/acp-trace.jsonl"
    top = 8
    for f in flags:
        if f.startswith("--top="):
            top = int(f.split("=", 1)[1])

    try:
        spans, bad = load(path)
    except FileNotFoundError:
        print(f"trace file not found: {path}", file=sys.stderr)
        return 2

    if not spans:
        print(f"no spans parsed from {path}", file=sys.stderr)
        return 2

    report = {
        "path": path,
        "span_count": len(spans),
        "bad_lines": bad,
        "roles": sorted({s.role for s in spans if s.role}),
        "axis1": axis1_bugs(spans, top),
        "axis2": axis2_dataflow(spans, top),
        "axis3": axis3_simplification(spans, top),
    }

    if "--json" in flags:
        print(json.dumps(report, indent=2))
    else:
        print(render(report))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
