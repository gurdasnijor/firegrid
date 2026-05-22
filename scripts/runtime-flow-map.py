#!/usr/bin/env python3
"""Runtime data-flow "contrast scan" over a Firegrid OTel JSONL trace.

The radiologist's trick: a static atlas (depcruiser's import graph) shows which
vessels *could* connect, but the runtime's real coupling is dynamic dispatch —
Effect layers, DI, channels, workflow signals — which never appears as an import.
OTel spans are a contrast agent already injected into that flow: every span knows
the source file that emitted it (its `withSpan("...")` site), its parent, and its
`context.id`. Collapsing the parent->child span tree to a *file x file* weighted
graph yields an angiogram of how data actually flows at runtime; overlaying it on
depcruiser's static graph pinpoints the diagnostic seams.

Three overlay categories fall out of the join:
  - static edge, NO runtime flow      -> cold/dead path (deletion candidate)
  - runtime flow, NO static import     -> invisible dynamic coupling (the part
                                          docs miss and depcruiser can't see)
  - heavy bidirectional flow           -> chatty seam (consolidation candidate)

Plus dynamic-only smells: hubs (god-modules), feedback cycles (self-feeding
loops), amplification (one context.id -> N spans), and leak-points (parent link
broken but context.id continues -> where causal context is dropped between
subsystems).

Pure stdlib. Reads the per-span JSONL from `@firegrid/observability`'s
JsonlFileSpanExporter (one span/line; hrtime [s, ns] pairs). Optionally renders a
DOT graph (pipe to graphviz `dot`).

Usage:
    python3 scripts/runtime-flow-map.py TRACE.jsonl \\
        [--depcruise dc.json] [--granularity file|subsystem] \\
        [--focus SUBSTR] [--dot OUT.dot] [--top N] [--repo .]

    # produce the static overlay input:
    npx depcruise --config .dependency-cruiser.cjs --output-type json \\
        packages/*/src > dc.json
"""

from __future__ import annotations

import json
import os
import re
import sys
from collections import Counter, defaultdict

# ---------------------------------------------------------------------------
# 1. span-name -> emitting-file attribution (the "dye pickup" map)
# ---------------------------------------------------------------------------

_WITHSPAN = re.compile(r'withSpan\(\s*"([^"]+)"')


def build_emission_map(repo):
    """Scan packages/*/src for withSpan("literal") sites -> {span_name: file}."""
    emap = {}
    root = os.path.join(repo, "packages")
    for dirpath, _dirs, files in os.walk(root):
        if "node_modules" in dirpath or "/test" in dirpath or "/.turbo" in dirpath:
            continue
        for fn in files:
            if not fn.endswith((".ts", ".tsx")):
                continue
            full = os.path.join(dirpath, fn)
            try:
                text = open(full, "r", errors="ignore").read()
            except OSError:
                continue
            rel = os.path.relpath(full, repo)
            for m in _WITHSPAN.finditer(text):
                # first definition wins; collisions are rare and benign
                emap.setdefault(m.group(1), rel)
    return emap


_IDISH = re.compile(r"(ctx_ext|input_|acp_|req_ctx|acp-prompt-)[A-Za-z0-9_\-/]+|"
                    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}\S*|[A-Za-z0-9+/=]{20,}")


def subsystem_of(name):
    """Coarse subsystem bucket for an unattributed span name (id-stripped)."""
    head = _IDISH.sub("", name.split(" ", 1)[0]).strip("./")  # drop dynamic id tails
    parts = [seg for seg in re.split(r"[./]", head) if seg]
    if not parts:
        return "unknown"
    if parts[0] == "firegrid":
        return ".".join(parts[:3])          # firegrid.runtime-context.state, etc.
    return parts[0]                          # McpServer / Toolkit / http etc.


class Attributor:
    """Maps a (possibly dynamic) span name to a graph node id + package."""

    def __init__(self, emission_map, granularity):
        self.emap = emission_map
        self.granularity = granularity
        # longest known names first so prefix match is greedy
        self._names = sorted(emission_map, key=len, reverse=True)
        self._cache = {}

    def _file_for(self, name):
        f = self.emap.get(name)
        if f:
            return f
        for known in self._names:
            if name == known or name.startswith(known + "."):
                return self.emap[known]
        return None

    def node(self, name):
        """-> (node_id, package). node_id is a file path or '~subsystem'."""
        hit = self._cache.get(name)
        if hit:
            return hit
        f = self._file_for(name)
        if f:
            pkg = _pkg_of_file(f)
            node = f if self.granularity == "file" else pkg
        else:
            sub = subsystem_of(name)
            node = "~" + sub
            pkg = "~unattributed"
        self._cache[name] = (node, pkg)
        return node, pkg


def _pkg_of_file(rel):
    m = re.match(r"packages/([^/]+)/", rel)
    return m.group(1) if m else "external"


# ---------------------------------------------------------------------------
# 2. span model + load
# ---------------------------------------------------------------------------

def _hr_ms(hr):
    if not hr or not isinstance(hr, list) or len(hr) != 2:
        return 0.0
    return hr[0] * 1000.0 + hr[1] / 1e6


def load_spans(path):
    spans, bad = [], 0
    with open(path, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                bad += 1
                continue
            attrs = r.get("attributes") or {}
            spans.append({
                "name": r.get("name", ""),
                "id": r.get("spanId"),
                "parent": r.get("parentSpanId"),
                "dur": _hr_ms(r.get("duration")),
                "ctx": attrs.get("firegrid.context.id"),
                "end": r.get("endTime"),
            })
    return spans, bad


# ---------------------------------------------------------------------------
# 3. flow graph (parent -> child collapsed to node x node)
# ---------------------------------------------------------------------------

def _quantile(vals, q):
    if not vals:
        return 0.0
    s = sorted(vals)
    if len(s) == 1:
        return s[0]
    pos = q * (len(s) - 1)
    lo = int(pos)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] * (1 - (pos - lo)) + s[hi] * (pos - lo)


def build_graph(spans, attr):
    name_by_id = {s["id"]: s["name"] for s in spans}

    node_pkg = {}
    node_spans = Counter()          # spans attributed to node
    node_ctx = defaultdict(set)     # distinct context.ids seen at node
    edge_count = Counter()          # (src,dst) -> count
    edge_lat = defaultdict(list)    # (src,dst) -> [child dur ms]
    leak = Counter()                # node -> spans whose parent link broke but ctx present

    for s in spans:
        node, pkg = attr.node(s["name"])
        node_pkg[node] = pkg
        node_spans[node] += 1
        if s["ctx"]:
            node_ctx[node].add(s["ctx"])

        p = s["parent"]
        if not p:
            continue
        pname = name_by_id.get(p)
        if pname is None:
            # parent absent from capture: a broken causal link. If context
            # continues here, it's a leak-point (context dropped across a seam).
            if s["ctx"]:
                leak[node] += 1
            continue
        pnode, ppkg = attr.node(pname)
        node_pkg.setdefault(pnode, ppkg)
        if pnode == node:
            continue                # intra-module call; not a decomposition edge
        edge_count[(pnode, node)] += 1
        edge_lat[(pnode, node)].append(s["dur"])

    # node degrees
    out_deg = Counter()
    in_deg = Counter()
    out_vol = Counter()
    in_vol = Counter()
    for (src, dst), c in edge_count.items():
        out_deg[src] += 1
        in_deg[dst] += 1
        out_vol[src] += c
        in_vol[dst] += c

    return {
        "node_pkg": node_pkg,
        "node_spans": node_spans,
        "node_ctx": {n: len(c) for n, c in node_ctx.items()},
        "edge_count": edge_count,
        "edge_lat": edge_lat,
        "leak": leak,
        "out_deg": out_deg, "in_deg": in_deg,
        "out_vol": out_vol, "in_vol": in_vol,
    }


def find_sccs(nodes, edges):
    """Tarjan SCC over the node graph; returns components with >1 node
    (mutually-recursive module clusters = feedback loops)."""
    adj = defaultdict(list)
    for (src, dst) in edges:
        adj[src].append(dst)
    index = {}
    low = {}
    onstack = {}
    stack = []
    counter = [0]
    out = []

    import sys as _sys
    _sys.setrecursionlimit(10000)

    def strong(v):
        index[v] = low[v] = counter[0]
        counter[0] += 1
        stack.append(v)
        onstack[v] = True
        for w in adj[v]:
            if w not in index:
                strong(w)
                low[v] = min(low[v], low[w])
            elif onstack.get(w):
                low[v] = min(low[v], index[w])
        if low[v] == index[v]:
            comp = []
            while True:
                w = stack.pop()
                onstack[w] = False
                comp.append(w)
                if w == v:
                    break
            if len(comp) > 1:
                out.append(comp)

    for n in nodes:
        if n not in index:
            strong(n)
    return out


# ---------------------------------------------------------------------------
# 4. depcruiser overlay
# ---------------------------------------------------------------------------

def load_static_edges(path, granularity):
    """-> (file_or_pkg_edges, pkg_pairs). pkg_pairs (unordered, cross-package)
    lets the overlay treat a cross-package dynamic edge as statically backed even
    when the file-level import resolved to the package's barrel/index."""
    d = json.load(open(path))
    edges = set()
    pkg_pairs = set()
    for mod in d.get("modules", []):
        src = mod.get("source", "")
        for dep in mod.get("dependencies", []):
            dst = dep.get("resolved", "")
            if not dst.startswith("packages/"):
                continue
            a, b = _pkg_of_file(src), _pkg_of_file(dst)
            if a != b:
                pkg_pairs.add(frozenset((a, b)))
            if granularity == "file":
                edges.add((src, dst))
            elif a != b:
                edges.add((a, b))
    return edges, pkg_pairs


def overlay(graph, static):
    """Classify module pairs. Static/dynamic presence compared on UNORDERED
    pairs (runtime parent->child need not match import direction); chatty uses
    directionality."""
    static_edges, pkg_pairs = static
    dyn = graph["edge_count"]
    dyn_pairs = {frozenset(e) if e[0] != e[1] else (e[0],) for e in dyn}
    stat_pairs = {frozenset(e) if e[0] != e[1] else (e[0],) for e in static_edges}

    # only file/pkg nodes participate in overlay; subsystem (~) nodes are skipped
    def real(pair):
        return all(not n.startswith("~") for n in pair)

    dynamic_only = []   # runtime flow, no static import -> invisible coupling
    for (src, dst), c in dyn.items():
        if src.startswith("~") or dst.startswith("~"):
            continue
        key = frozenset((src, dst)) if src != dst else (src,)
        if key in stat_pairs:
            continue
        # cross-package flow backed by a barrel import is NOT invisible coupling
        psrc, pdst = _pkg_of_file(src), _pkg_of_file(dst)
        if psrc != pdst and frozenset((psrc, pdst)) in pkg_pairs:
            continue
        dynamic_only.append(((src, dst), c))
    dynamic_only.sort(key=lambda kv: -kv[1])

    cold_static = [p for p in stat_pairs
                   if real(list(p)) and p not in dyn_pairs]

    # chatty: meaningful flow in BOTH directions between a real pair
    chatty = []
    seen = set()
    for (src, dst), c in dyn.items():
        if src.startswith("~") or dst.startswith("~") or src == dst:
            continue
        key = frozenset((src, dst))
        if key in seen:
            continue
        back = dyn.get((dst, src), 0)
        if c > 0 and back > 0:
            chatty.append((tuple(sorted((src, dst))), c + back, c, back))
            seen.add(key)
    chatty.sort(key=lambda x: -x[1])

    return {
        "dynamic_only": dynamic_only,
        "cold_static": cold_static,
        "chatty": chatty,
        "static_pair_count": len(stat_pairs),
        "dynamic_pair_count": len(dyn_pairs),
    }


# ---------------------------------------------------------------------------
# 5. render
# ---------------------------------------------------------------------------

def short(node):
    if node.startswith("~"):
        return node
    return re.sub(r"^packages/", "", node)


def render_tables(graph, ov, top, focus):
    L = []
    p = L.append
    ec = graph["edge_count"]
    el = graph["edge_lat"]
    nodes = graph["node_spans"]

    def touches(pair):
        return not focus or any(focus in n for n in pair)

    p("=" * 90)
    p("RUNTIME DATA-FLOW MAP  (contrast scan)")
    if focus:
        p(f"  focus filter: edges touching '{focus}'")
    p("=" * 90)
    p(f"NODES: {len(nodes)}   EDGES: {len(ec)}   "
      f"(dynamic pairs {ov['dynamic_pair_count'] if ov else 'n/a'} / "
      f"static pairs {ov['static_pair_count'] if ov else 'n/a'})")

    # --- hubs: god-modules by total flow degree ---
    p("\n-- HUBS (god-modules: distinct in/out neighbors, then volume) --")
    deg = [n for n in sorted(nodes, key=lambda n: -(graph['in_deg'][n] + graph['out_deg'][n]))
           if not focus or focus in n]
    for n in deg[:top]:
        p(f"  {graph['in_deg'][n]:>3}in {graph['out_deg'][n]:>3}out  "
          f"vol {graph['in_vol'][n]:>7}/{graph['out_vol'][n]:<7} "
          f"spans {nodes[n]:>6}  ctx {graph['node_ctx'].get(n,0):>3}  {short(n)}")

    # --- heaviest flow edges (by count) ---
    p("\n-- HEAVIEST FLOW EDGES (parent->child invocation count) --")
    edges_by_count = [e for e in sorted(ec.items(), key=lambda kv: -kv[1]) if touches(e[0])]
    for (src, dst), c in edges_by_count[:top]:
        lat = el[(src, dst)]
        p(f"  {c:>7}x  p50 {_quantile(lat,0.5):>6.1f}ms p95 {_quantile(lat,0.95):>7.1f}ms  "
          f"{short(src)}  ->  {short(dst)}")

    # --- where the wall budget goes (by total child latency on the edge) ---
    p("\n-- COSTLIEST FLOW EDGES (total child wall ms on the edge) --")
    edges_by_ms = sorted(((e, sum(el[e])) for e in ec if touches(e)), key=lambda kv: -kv[1])
    for (src, dst), ms in edges_by_ms[:top]:
        p(f"  {ms:>9.0f}ms  ({ec[(src,dst)]}x)  {short(src)}  ->  {short(dst)}")

    # --- feedback cycles (SCCs > 1 node = mutually-recursive modules) ---
    sccs = find_sccs(list(nodes), list(ec.keys()))
    p(f"\n-- FEEDBACK CYCLES (mutually-recursive module clusters): {len(sccs)} --")
    for comp in sorted(sccs, key=lambda c: -len(c))[:top]:
        p(f"  [{len(comp)}]  " + "  <->  ".join(short(n) for n in comp[:6])
          + (" ..." if len(comp) > 6 else ""))

    # --- amplification: one context.id -> many spans at a node ---
    p("\n-- AMPLIFICATION (spans per distinct context.id at a node) --")
    amp = []
    for n, ns in nodes.items():
        ctx = graph["node_ctx"].get(n, 0)
        if ctx > 0 and (not focus or focus in n):
            amp.append((n, ns / ctx, ns, ctx))
    for n, ratio, ns, ctx in sorted(amp, key=lambda x: -x[1])[:top]:
        p(f"  {ratio:>8.1f}x  ({ns} spans / {ctx} ctx)  {short(n)}")

    # --- leak-points: parent link broken but context.id continues ---
    leak = graph["leak"]
    p(f"\n-- LEAK-POINTS (parent span absent but context.id continues = "
      f"dropped causal context) --")
    for n, c in leak.most_common(top):
        if not focus or focus in n:
            p(f"  {c:>7}  {short(n)}")

    # --- overlay diagnostics ---
    if ov:
        p("\n-- INVISIBLE COUPLING (runtime flow, NO static import) --")
        p("   [DI / Effect layer / channel / workflow-signal — the docs miss these]")
        shown = [e for e in ov["dynamic_only"] if touches(e[0])]
        for (src, dst), c in shown[:top]:
            p(f"  {c:>7}x  {short(src)}  ->  {short(dst)}")

        p("\n-- CHATTY SEAMS (heavy BOTH directions; consolidation candidates) --")
        chatty = [c for c in ov["chatty"]
                  if not focus or focus in c[0][0] or focus in c[0][1]]
        for pair, tot, fwd, back in chatty[:top]:
            p(f"  {tot:>7}x ({fwd}->/{back}<-)  {short(pair[0])}  <->  {short(pair[1])}")

        p("\n-- COLD STATIC EDGES (import exists, ZERO flow in THIS capture; "
          f"union multiple scenarios before calling dead): {len(ov['cold_static'])} --")
        cold = []
        for pr in ov["cold_static"]:
            members = list(pr)
            if focus and not any(focus in m for m in members):
                continue
            cold.append(members)
        for members in cold[:top]:
            if len(members) == 2:
                p(f"  {short(members[0])}  ->  {short(members[1])}")
            else:
                p(f"  {short(members[0])}  (self)")

    return "\n".join(L)


# ---------------------------------------------------------------------------
# DOT
# ---------------------------------------------------------------------------

_PALETTE = ["#4e79a7", "#f28e2b", "#59a14f", "#e15759", "#76b7b2",
            "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac"]


def render_dot(graph, ov, focus):
    ec = graph["edge_count"]
    nodes = graph["node_spans"]
    pkgs = sorted({graph["node_pkg"].get(n, "external") for n in nodes})
    pkg_color = {pk: _PALETTE[i % len(_PALETTE)] for i, pk in enumerate(pkgs)}
    dyn_only = {e for e, _ in (ov["dynamic_only"] if ov else [])}

    def touches(e):
        return not focus or focus in e[0] or focus in e[1]

    keep_edges = {e: c for e, c in ec.items() if touches(e)}
    keep_nodes = {n for e in keep_edges for n in e}

    L = ["digraph runtime_flow {", '  rankdir=LR; node [shape=box,style="filled,rounded",'
         'fontname="Helvetica",fontsize=10]; edge [fontname="Helvetica",fontsize=8];']
    # cluster by package
    by_pkg = defaultdict(list)
    for n in keep_nodes:
        by_pkg[graph["node_pkg"].get(n, "external")].append(n)
    for i, (pk, ns) in enumerate(sorted(by_pkg.items())):
        L.append(f'  subgraph cluster_{i} {{ label="{pk}"; style=dashed; color="#888888";')
        for n in ns:
            mx = max(nodes.values()) or 1
            pen = 1 + 3 * (nodes[n] / mx)
            L.append(f'    "{n}" [label="{short(n)}\\n{nodes[n]} spans",'
                     f'fillcolor="{pkg_color[pk]}33",penwidth={pen:.1f}];')
        L.append("  }")
    mxe = max(keep_edges.values()) or 1
    for (src, dst), c in keep_edges.items():
        w = 0.5 + 4 * (c / mxe)
        color = "#e15759" if (src, dst) in dyn_only else "#33333399"
        style = "bold" if (src, dst) in dyn_only else "solid"
        L.append(f'  "{src}" -> "{dst}" [label="{c}",penwidth={w:.1f},'
                 f'color="{color}",style={style}];')
    L.append("}")
    L.append("// red/bold edges = invisible coupling (runtime flow, no static import)")
    return "\n".join(L)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    flags = {}
    for a in argv[1:]:
        if a.startswith("--") and "=" in a:
            k, v = a[2:].split("=", 1)
            flags[k] = v
        elif a.startswith("--"):
            flags[a[2:]] = True
    if not args:
        print(__doc__)
        return 2
    traces = args                          # one or more trace.jsonl (union = corpus)
    repo = flags.get("repo", ".")
    granularity = flags.get("granularity", "file")
    focus = flags.get("focus")
    top = int(flags.get("top", 15))

    emap = build_emission_map(repo)
    attr = Attributor(emap, granularity)
    spans, bad = [], 0
    for t in traces:
        s, b = load_spans(t)
        spans.extend(s)
        bad += b
    if not spans:
        print(f"no spans in {traces}", file=sys.stderr)
        return 2
    graph = build_graph(spans, attr)

    ov = None
    dc = flags.get("depcruise")
    if dc and os.path.exists(dc):
        ov = overlay(graph, load_static_edges(dc, granularity))

    print(f"# emission sites: {len(emap)}   spans: {len(spans)} "
          f"(bad {bad})   granularity: {granularity}", file=sys.stderr)
    print(render_tables(graph, ov, top, focus))

    if flags.get("dot"):
        with open(flags["dot"], "w") as f:
            f.write(render_dot(graph, ov, focus))
        print(f"\n# DOT written: {flags['dot']}  "
              f"(render: dot -Tsvg {flags['dot']} -o flow.svg)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
