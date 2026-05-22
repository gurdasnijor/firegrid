#!/usr/bin/env python3
"""Runtime data-flow "contrast scan" over a Firegrid OTel JSONL trace.

A static atlas (depcruiser's import graph) shows which vessels *could* connect,
but the runtime's real coupling is dynamic dispatch — Effect layers, DI, channels,
workflow signals — which never appears as an import. OTel spans are a contrast
agent already injected: every span knows the file that emitted it (its
`withSpan` / `Activity.make` site), its parent, and its `context.id`. Collapsing
the parent->child span tree into a file x file graph is an angiogram of how data
actually flows; overlaying it on depcruiser pinpoints the diagnostic seams.

Built on networkx: parse -> build_graph(spans) -> nx.MultiDiGraph with derived
node/edge attributes -> reports query the graph.

Headline practice = CONTRACT-COVERAGE (--contracts): every exercised seam must
declare the invariant it enforces (firegrid.contract.id = an ACID/SDD id) or it
is a collapse candidate. Inverts the static-lint oracle problem: not "should this
have a span?" (no oracle) but "this span ran — what invariant does it carry?"
(answerable by the author). Collapse-detection (--skeleton) is the consequence.

REQUIRES networkx (+ scipy for pagerank) — run via uv (no install, no system change):
    uv run --with networkx --with scipy python3 scripts/runtime-flow-map.py TRACE.jsonl [opts]

Options:
    --depcruise=dc.json   overlay static imports (npx depcruise --output-type json packages/*/src)
    --contracts           contract-coverage + annotate-or-collapse worklist  [headline]
    --skeleton            nx graph-shrink: condensation, relay contraction, centrality, k-core
    --coverage            runtime-flow x static-consumers 2x2 (dead vs coverage gap)
    --dot=out.dot         write DOT (then: dot -Tsvg out.dot -o flow.svg)
    --timeline=out.svg    LTR swimlane (SINGLE trace only)
    --focus=SUBSTR        filter edges touching a module
    --granularity=file|subsystem    --top=N    --repo=.
"""

from __future__ import annotations

import json
import os
import re
import sys
from collections import Counter, defaultdict

try:
    import networkx as nx
except ModuleNotFoundError:
    sys.stderr.write(
        "networkx required. Run:\n"
        "  uv run --with networkx python3 scripts/runtime-flow-map.py ...\n")
    sys.exit(3)


# ===========================================================================
# attribution: span name -> emitting file
# ===========================================================================

_WITHSPAN = re.compile(r'withSpan\(\s*"([^"]+)"')
_NAMEFIELD = re.compile(r'name:\s*[`"](firegrid\.[A-Za-z0-9_.\-]+)')
_IDISH = re.compile(r"(ctx_ext|input_|acp_|req_ctx|acp-prompt-)[A-Za-z0-9_\-/]+|"
                    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}\S*|[A-Za-z0-9+/=]{20,}")


def build_emission_map(repo):
    """Span name (or static prefix) -> emitting file. Covers withSpan("…") and
    Activity/Workflow `name:` fields (incl. the static prefix of a dynamic name)."""
    emap = {}
    for dirpath, _dirs, files in os.walk(os.path.join(repo, "packages")):
        if "node_modules" in dirpath or "/test" in dirpath or "/.turbo" in dirpath:
            continue
        for fn in files:
            if not fn.endswith((".ts", ".tsx")):
                continue
            try:
                text = open(os.path.join(dirpath, fn), "r", errors="ignore").read()
            except OSError:
                continue
            rel = os.path.relpath(os.path.join(dirpath, fn), repo)
            for m in _WITHSPAN.finditer(text):
                emap.setdefault(m.group(1), rel)
            for m in _NAMEFIELD.finditer(text):
                emap.setdefault(m.group(1).rstrip("."), rel)
    return emap


def _pkg_of_file(rel):
    m = re.match(r"packages/([^/]+)/", rel or "")
    return m.group(1) if m else "external"


def _subsystem(name):
    head = _IDISH.sub("", name.split(" ", 1)[0]).strip("./")
    parts = [s for s in re.split(r"[./]", head) if s]
    if not parts:
        return "unknown"
    return ".".join(parts[:3]) if parts[0] == "firegrid" else parts[0]


class Attributor:
    def __init__(self, emission_map, granularity):
        self.emap = emission_map
        self.granularity = granularity
        self._names = sorted(emission_map, key=len, reverse=True)
        self._cache = {}

    def _file_for(self, name):
        if name in self.emap:
            return self.emap[name]
        for known in self._names:
            if name == known or name.startswith(known + "."):
                return self.emap[known]
        return None

    def node(self, name):
        if name in self._cache:
            return self._cache[name]
        f = self._file_for(name)
        if f:
            node, pkg = (f if self.granularity == "file" else _pkg_of_file(f)), _pkg_of_file(f)
        else:
            node, pkg = "~" + _subsystem(name), "~unattributed"
        self._cache[name] = (node, pkg)
        return node, pkg


def _norm_op(name):
    """Span name -> op family: ids/uuids/base64 and numeric path segments -> '*'."""
    n = _IDISH.sub("*", name)
    n = re.sub(r'(?<=[./])-?\d+(?=$|[./ ])', '*', n)
    n = re.sub(r'(?:[./]\*)+', '.*', n)
    return n.strip()


def _state_effect(name):
    if re.search(r'\.(insert|insertOrGet|insert_or_get|upsert|delete)\b', name) \
       or re.search(r'(producer_append|log\.append|event\.append|completion\.write)', name):
        return "write"
    if ".claim" in name:
        return "claim"
    if re.search(r'durable_table\.(get|query|rows)', name) \
       or "agent_output.initial" in name or "agent_output.after" in name:
        return "read"
    return "none"


_EFFECT_RANK = {"none": 0, "read": 1, "claim": 2, "write": 3}


def _is_process(name):
    return (name.startswith("http") or "_bytes" in name
            or "durable_streams.http" in name or " /" in name or "local_process" in name)


# ===========================================================================
# load
# ===========================================================================

def _hr_ms(hr):
    return (hr[0] * 1000.0 + hr[1] / 1e6) if isinstance(hr, list) and len(hr) == 2 else 0.0


def load_spans(paths):
    spans, bad = [], 0
    for path in paths:
        for line in open(path, "r"):
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                bad += 1
                continue
            at = r.get("attributes") or {}
            spans.append({
                "name": r.get("name", ""), "id": r.get("spanId"),
                "parent": r.get("parentSpanId"),
                "start": _hr_ms(r.get("startTime")), "dur": _hr_ms(r.get("duration")),
                "ctx": at.get("firegrid.context.id"),
                "contract": at.get("firegrid.contract.id"),
                "seam": at.get("firegrid.seam.kind"),
            })
    return spans, bad


# ===========================================================================
# build_graph: spans -> nx.MultiDiGraph with derived node/edge attributes
# ===========================================================================

def build_graph(spans, attr):
    name_by_id = {s["id"]: s["name"] for s in spans}
    kids = defaultdict(float)
    for s in spans:
        if s["parent"] in name_by_id:
            kids[s["parent"]] += s["dur"]

    G = nx.MultiDiGraph()
    own, selfby, nspans = defaultdict(float), defaultdict(float), Counter()
    ctxs, has_contract, eff = defaultdict(set), defaultdict(bool), defaultdict(int)

    for s in spans:
        n, pkg = attr.node(s["name"])
        own[n] += s["dur"]
        selfby[n] += max(s["dur"] - kids[s["id"]], 0.0)
        nspans[n] += 1
        if s["ctx"]:
            ctxs[n].add(s["ctx"])
        if s["contract"]:
            has_contract[n] = True
        eff[n] = max(eff[n], _EFFECT_RANK[_state_effect(s["name"])])
        if not G.has_node(n):
            G.add_node(n, pkg=pkg)
        p = s["parent"]
        pn = attr.node(name_by_id[p])[0] if p in name_by_id else None
        if pn is not None and pn != n:
            if not G.has_node(pn):
                G.add_node(pn, pkg=attr.node(name_by_id[p])[1])
            G.add_edge(pn, n, op=_norm_op(s["name"]), dur=s["dur"],
                       self_time=max(s["dur"] - kids[s["id"]], 0.0),
                       state_effect=_state_effect(s["name"]),
                       contract=s["contract"], seam=s["seam"])

    inv_eff = {v: k for k, v in _EFFECT_RANK.items()}
    for n in G.nodes:
        tot = own[n] or 1.0
        G.nodes[n].update(
            n_spans=nspans[n], self_ms=selfby[n], total_ms=own[n],
            self_frac=selfby[n] / tot, n_ctx=len(ctxs[n]),
            has_contract=has_contract[n], state_effect=inv_eff[eff[n]])

    # domain crossing
    for n in G.nodes:
        own_dom = G.nodes[n]["pkg"]
        neigh = {G.nodes[m]["pkg"] for m in set(G.predecessors(n)) | set(G.successors(n))}
        G.nodes[n]["crosses"] = any(d != own_dom for d in neigh)

    # structural metrics on simple projections
    DG = _digraph(G)
    UG = nx.Graph()
    UG.add_nodes_from(DG.nodes)
    UG.add_edges_from((u, v) for u, v in DG.edges if u != v)
    btw = nx.betweenness_centrality(DG) if DG.number_of_nodes() > 2 else {}
    try:  # pagerank needs scipy/numpy in nx 3.x; degrade to a degree proxy if absent
        pr = nx.pagerank(DG, weight="weight") if DG.number_of_edges() else {}
    except (ImportError, ModuleNotFoundError):
        tot = sum(d["weight"] for _, _, d in DG.edges(data=True)) or 1
        pr = {n: sum(DG.edges[u, v]["weight"] for u, v in DG.in_edges(n)) / tot for n in DG.nodes}
    core = nx.core_number(UG) if UG.number_of_edges() else {}
    ap = set(nx.articulation_points(UG)) if UG.number_of_edges() else set()
    for n in G.nodes:
        G.nodes[n].update(betweenness=btw.get(n, 0.0), pagerank=pr.get(n, 0.0),
                          core=core.get(n, 0), articulation=n in ap)
    return G


def _digraph(G):
    """Aggregate the MultiDiGraph to a weighted DiGraph (weight=call count)."""
    DG = nx.DiGraph()
    for n, d in G.nodes(data=True):
        DG.add_node(n, **d)
    agg = defaultdict(lambda: {"weight": 0, "durs": [], "ops": Counter()})
    for u, v, d in G.edges(data=True):
        e = agg[(u, v)]
        e["weight"] += 1
        e["durs"].append(d.get("dur", 0.0))
        e["ops"][d.get("op", "")] += 1
    for (u, v), e in agg.items():
        DG.add_edge(u, v, **e)
    return DG


# ===========================================================================
# helpers
# ===========================================================================

def short(n):
    return n if n.startswith("~") else re.sub(r"^packages/", "", n)


def _q(vals, q):
    if not vals:
        return 0.0
    s = sorted(vals)
    if len(s) == 1:
        return s[0]
    pos = q * (len(s) - 1)
    lo = int(pos)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] * (1 - (pos - lo)) + s[hi] * (pos - lo)


def load_static(path, granularity):
    d = json.load(open(path))
    edges, pkg_pairs = set(), set()
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


# ===========================================================================
# reports: G -> str
# ===========================================================================

def report_flow(G, top, focus):
    DG = _digraph(G)
    L = ["=" * 90, "RUNTIME DATA-FLOW MAP" + (f"  (focus: {focus})" if focus else ""), "=" * 90,
         f"nodes {G.number_of_nodes()}  edges(distinct pairs) {DG.number_of_edges()}  "
         f"spans {sum(d['n_spans'] for _, d in G.nodes(data=True))}"]

    def tch(u, v):
        return not focus or focus in u or focus in v

    L.append("\n-- HUBS (pagerank = everyone-routes-here; self% = does-real-work) --")
    for n, d in sorted(G.nodes(data=True), key=lambda x: -x[1]["pagerank"])[:top]:
        if focus and focus not in n:
            continue
        flag = "CORE" if d["articulation"] else ""
        L.append(f"  pr {d['pagerank']:.3f}  btw {d['betweenness']:.2f}  k{d['core']:<2} "
                 f"self {d['self_frac']*100:>3.0f}%  spans {d['n_spans']:>6}  {flag:4} {short(n)}")

    L.append("\n-- HEAVIEST FLOW EDGES (calls; p50/p95 child ms) --")
    for (u, v), d in sorted(((e, DG.edges[e]) for e in DG.edges if tch(*e)),
                            key=lambda x: -x[1]["weight"])[:top]:
        L.append(f"  {d['weight']:>7}x  p50 {_q(d['durs'],.5):>6.1f} p95 {_q(d['durs'],.95):>7.1f}ms  "
                 f"{short(u)} -> {short(v)}")
    return "\n".join(L)


def report_overlay(G, static, top, focus):
    static_edges, pkg_pairs = static
    DG = _digraph(G)
    dyn = {(u, v): DG.edges[u, v]["weight"] for u, v in DG.edges}
    dyn_pairs = {frozenset(e) if e[0] != e[1] else (e[0],) for e in dyn}
    stat_pairs = {frozenset(e) if e[0] != e[1] else (e[0],) for e in static_edges}

    def tch(e):
        return not focus or focus in e[0] or focus in e[1]

    invisible = []
    for (u, v), c in dyn.items():
        if u.startswith("~") or v.startswith("~"):
            continue
        if (frozenset((u, v)) if u != v else (u,)) in stat_pairs:
            continue
        pu, pv = _pkg_of_file(u), _pkg_of_file(v)
        if pu != pv and frozenset((pu, pv)) in pkg_pairs:
            continue
        invisible.append(((u, v), c))
    invisible.sort(key=lambda x: -x[1])

    L = ["", "=" * 90, "STATIC x DYNAMIC OVERLAY", "=" * 90,
         f"  static pairs {len(stat_pairs)}   dynamic pairs {len(dyn_pairs)}"]
    L.append("\n-- INVISIBLE COUPLING (runtime flow, NO static import — DI/layer/channel/signal) --")
    for (u, v), c in [e for e in invisible if tch(e[0])][:top]:
        L.append(f"  {c:>7}x  {short(u)} -> {short(v)}")
    cold = [p for p in stat_pairs if all(not n.startswith("~") for n in p) and p not in dyn_pairs]
    L.append(f"\n-- COLD STATIC EDGES (import, zero flow this corpus): {len(cold)} "
             f"(union more scenarios before calling dead) --")
    return "\n".join(L)


def report_coverage(G, static, top):
    """runtime-flow x static-consumers 2x2 over emitting files."""
    imported = {dst for (src, dst) in static[0]} if static else set()
    L = ["", "=" * 90, "COVERAGE 2x2 (runtime-flow x static-consumers)", "=" * 90]
    fired = {n for n, d in G.nodes(data=True) if not n.startswith("~")}
    dead = [n for n in imported if n not in fired]
    L.append(f"  fired (this corpus): {len(fired)}   static files imported: {len(imported)}")
    L.append(f"  imported but NEVER fired (coverage gap or dead): {len(dead)}")
    for n in sorted(dead)[:top]:
        L.append(f"    {short(n)}")
    L.append("  (dead requires ALSO no real consumer — verify before deleting.)")
    return "\n".join(L)


def report_contracts(spans, attr, G, top):
    """Headline: every exercised seam declares its invariant (contract.id) or
    is a collapse candidate. Triage uncovered seams via derivable proxies."""
    ops = {}
    for s in spans:
        key = _norm_op(s["name"])
        o = ops.setdefault(key, {"count": 0, "contract": None, "node": attr.node(s["name"])[0]})
        o["count"] += 1
        if s["contract"]:
            o["contract"] = s["contract"]
    tot_ops, just_ops = len(ops), sum(1 for o in ops.values() if o["contract"])
    tot_sp = sum(o["count"] for o in ops.values())
    just_sp = sum(o["count"] for o in ops.values() if o["contract"])

    L = ["", "=" * 90,
         "CONTRACT-COVERAGE  (declare each exercised seam's invariant, or collapse it)",
         "=" * 90,
         f"  seams (op families): {tot_ops}   with contract.id: {just_ops} ({100*just_ops//max(tot_ops,1)}%)",
         f"  spans: {tot_sp}   under a contract: {just_sp} ({100*just_sp//max(tot_sp,1)}%)"]
    if just_ops == 0:
        L.append("  -> 0% today (schema not adopted). The pre-triaged worklist IS the value.")

    def verdict(op, node):
        d = G.nodes.get(node, {})
        if _is_process(op):
            return "NEEDS-CONTRACT", "process/network boundary"
        se = _state_effect(op)
        if se == "write":
            return "NEEDS-CONTRACT", "durability (commit)"
        if se == "claim":
            return "NEEDS-CONTRACT", "claim/idempotency"
        if d.get("articulation"):
            return "NEEDS-CONTRACT", "structural cut-vertex"
        if d.get("crosses"):
            return "NEEDS-CONTRACT", "domain/authority crossing"
        if d.get("self_frac", 1.0) < 0.15 and se in ("none", "read"):
            return "COLLAPSE-CANDIDATE", "pure indirection (low self-time, same domain, no write)"
        return "REVIEW", "carries work, no boundary proxy — author decides"

    buckets = defaultdict(list)
    for key, o in ops.items():
        if o["contract"]:
            continue
        vk, reason = verdict(key, o["node"])
        buckets[vk].append((o["count"], key, o["node"], reason))
    for vk, todo in [("NEEDS-CONTRACT", "annotate with the ACID/SDD it enforces"),
                     ("REVIEW", "author decides: invariant or collapse"),
                     ("COLLAPSE-CANDIDATE", "no invariant + pure indirection -> inline/remove")]:
        rows = sorted(buckets.get(vk, []), key=lambda r: -r[0])
        L.append(f"\n-- {vk}: {len(rows)} seams  [{todo}] --")
        for count, key, node, reason in rows[:top]:
            L.append(f"  {count:>7}x  {key}\n           ↳ {reason}  @ {short(node)}")
    return "\n".join(L)


def _is_relay(G, n):
    d = G.nodes[n]
    return (not d["articulation"] and not d["crosses"]
            and d["self_frac"] < 0.15 and d["state_effect"] in ("none", "read")
            and len(set(G.successors(n))) <= 2 and len(set(G.predecessors(n))) <= 2)


def report_skeleton(G, top):
    """nx graph-shrink: relay contraction + SCC condensation + centrality + k-core."""
    DG = _digraph(G)
    L = ["", "=" * 90, "SKELETON / SHRINK (networkx)", "=" * 90]

    # 1. relay contraction
    relays = [n for n in DG.nodes if _is_relay(G, n)]
    sk = DG.copy()
    for n in relays:
        if n not in sk:
            continue
        preds = list(sk.predecessors(n))
        if not preds:
            continue
        keep = max(preds, key=lambda u: sk.edges[u, n].get("weight", 1))
        sk = nx.contracted_nodes(sk, keep, n, self_loops=False)
    L.append(f"  nodes {DG.number_of_nodes()} -> after relay-contraction {sk.number_of_nodes()}  "
             f"(contracted {len(relays)} relays)")
    L.append("\n-- RELAY / COLLAPSE CANDIDATES (no boundary, ~no self-time, low fan) --")
    for n in sorted(relays, key=lambda n: -G.nodes[n]["n_spans"])[:top]:
        L.append(f"  {G.nodes[n]['n_spans']:>7} spans  {short(n)}")

    # 2. SCC condensation = the structural shrink (reciprocal pairs auto-merge)
    sccs = [c for c in nx.strongly_connected_components(DG) if len(c) > 1]
    cond = nx.condensation(DG)
    L.append(f"\n-- CONDENSATION (collapse cycles -> DAG): {DG.number_of_nodes()} nodes -> "
             f"{cond.number_of_nodes()} ({len(sccs)} cycles) --")
    for c in sorted(sccs, key=lambda c: -len(c))[:top]:
        L.append(f"  cycle[{len(c)}]: " + "  <->  ".join(short(x) for x in list(c)[:6]))

    # 3. k-core: inner core = irreducible spine; outer shell = peripheral/feature
    core = {n: G.nodes[n]["core"] for n in G.nodes}
    if core:
        kmax = max(core.values())
        spine = [n for n, k in core.items() if k == kmax]
        L.append(f"\n-- {kmax}-CORE (densely interconnected spine — cannot remove w/o disconnect) --")
        for n in sorted(spine, key=lambda n: -G.nodes[n]["pagerank"])[:top]:
            L.append(f"  pr {G.nodes[n]['pagerank']:.3f}  {short(n)}")

    # 4. structural-relay = high pagerank + low self-time (routes flow, does no work)
    L.append("\n-- STRUCTURAL RELAYS (high pagerank, low self-time = routes, doesn't work) --")
    cand = [(d["pagerank"], n) for n, d in G.nodes(data=True)
            if d["self_frac"] < 0.15 and d["pagerank"] > 0]
    for prv, n in sorted(cand, reverse=True)[:top]:
        L.append(f"  pr {prv:.3f}  self {G.nodes[n]['self_frac']*100:.0f}%  {short(n)}")
    return "\n".join(L)


# ===========================================================================
# baseline gate (deterministic enforcement): N must not rise (beyond credited
# SCC breaks), C must not fall, every contract.id must resolve.
# ===========================================================================

_ACID = re.compile(r'\b([a-z][a-z0-9]*(?:-[a-z0-9]+)+\.[A-Z][A-Z0-9_]+\.[0-9]+(?:-[0-9]+)?)\b')

# tf-fp3a: feature.yaml structure pieces, so a section ACID resolves even when
# it is never printed as a full contiguous token. The schema is fixed:
#   feature: / name: <feature-name> (@indent 2)
#   components: | constraints:      (@indent 0)
#     SECTION:                       (@indent 2, UPPER_SNAKE)
#       requirements:                (@indent 4)
#         N: | N-M: ...              (@indent 6, numeric key)
_FEATURE_NAME = re.compile(r'^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$')
_SECTION_KEY = re.compile(r'^([A-Z][A-Z0-9_]*):\s*$')
_REQ_KEY = re.compile(r'^([0-9]+(?:-[0-9]+)?):')


def _section_acids(path):
    """Derive valid `<feature-name>.SECTION.N` / `.N-M` contract ids from a
    feature.yaml's structure (components/constraints -> SECTION -> requirements
    -> numeric keys). Indentation-based against the fixed schema above, so an
    author can cite a section id without the full dotted token appearing
    literally. Only real (section, requirement-key) pairs are emitted — no
    cross-section product — so a typo'd section/number still fails to resolve."""
    ids = set()
    feature_name = None
    container = None        # "components" / "constraints" / None
    in_feature = False
    section = None
    in_requirements = False
    try:
        lines = open(path, errors="ignore").read().splitlines()
    except OSError:
        return ids
    for raw in lines:
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        body = raw.strip()
        if indent == 0:
            in_feature = body == "feature:"
            container = body[:-1] if body in ("components:", "constraints:") else None
            section = None
            in_requirements = False
        elif indent == 2:
            if in_feature and body.startswith("name:"):
                cand = body.split(":", 1)[1].strip()
                if _FEATURE_NAME.match(cand):
                    feature_name = cand
            elif container is not None:
                m = _SECTION_KEY.match(body)
                section = m.group(1) if m else None
                in_requirements = False
        elif indent == 4:
            in_requirements = (
                container is not None and section is not None and body == "requirements:"
            )
        elif indent == 6:
            m = _REQ_KEY.match(body)
            if in_requirements and feature_name and section and m:
                ids.add(f"{feature_name}.{section}.{m.group(1)}")
        # indent >= 8 (nested requirement maps, block scalars) is ignored
    return ids


def _contract_index(repo):
    """Deterministic set of valid contract ids: ACID tokens declared in any
    *.feature.yaml / .semgrep.yml (literal contiguous tokens), PLUS section
    ACIDs derived from each feature.yaml's structure (tf-fp3a). (contract.id
    also resolves if it is an existing repo path — checked separately.)"""
    ids = set()
    for dp, dirs, fs in os.walk(repo):
        if "node_modules" in dp or "/.git" in dp or "/.turbo" in dp:
            dirs[:] = [d for d in dirs if d not in ("node_modules", ".git", ".turbo")]
            continue
        for fn in fs:
            p = os.path.join(dp, fn)
            if fn.endswith(".feature.yaml"):
                try:
                    ids.update(_ACID.findall(open(p, errors="ignore").read()))
                except OSError:
                    pass
                ids.update(_section_acids(p))
            elif fn == ".semgrep.yml":
                try:
                    ids.update(_ACID.findall(open(p, errors="ignore").read()))
                except OSError:
                    pass
    return ids


def _resolve_contract(repo, idx, cid):
    if not cid or cid.strip().lower() in ("", "todo", "tbd", "fixme", "xxx"):
        return False
    return cid in idx or os.path.exists(os.path.join(repo, cid))


def _self_check(repo):
    """`--self-check`: prove the contract.id resolver, against the real repo.
    Section ACIDs derived from feature.yaml structure resolve; typo'd
    section/number and TODO-shaped ids fail; path-based decision-doc ids
    resolve. Mostly self-derived (picks real tokens from the live index) so it
    does not rot when feature files change; exits 1 on any failed assertion."""
    idx = _contract_index(repo)
    section_ids = sorted(t for t in idx if "/" not in t)
    checks = []
    def check(name, ok):
        checks.append((name, bool(ok)))

    check("derived >= 1 section ACID from feature.yaml structure", section_ids)
    sample = next((t for t in section_ids if re.fullmatch(_ACID, t)), None)
    if sample:
        name_part, section, key = sample.rsplit(".", 2)
        check(f"section ACID resolves: {sample}", _resolve_contract(repo, idx, sample))
        check(f"typo'd requirement number fails: {name_part}.{section}.99999",
              not _resolve_contract(repo, idx, f"{name_part}.{section}.99999"))
        check(f"typo'd section fails: {name_part}.ZZZ_NONEXISTENT.{key}",
              not _resolve_contract(repo, idx, f"{name_part}.ZZZ_NONEXISTENT.{key}"))
    nm = next((t for t in section_ids if re.search(r"\.[0-9]+-[0-9]+$", t)), None)
    check("derived an N-M section ACID", nm)

    for bad in ("TODO", "tbd", "FIXME", "", "firegrid-not-a-feature.NOPE.1"):
        check(f"rejects non-resolving id {bad!r}", not _resolve_contract(repo, idx, bad))

    # path-based decision-doc resolution preserved (and the tf-ykd5 regression
    # target: a section ACID that previously required a feature-file path).
    apath = "features/firegrid/firegrid-zed-acp-stdio-external-agent.feature.yaml"
    if os.path.exists(os.path.join(repo, apath)):
        check(f"path-based decision-doc resolves: {apath}",
              _resolve_contract(repo, idx, apath))
        target = "firegrid-zed-acp-stdio-external-agent.PROTOCOL_DISCIPLINE.3"
        check(f"tf-ykd5 target section ACID now resolves: {target}",
              _resolve_contract(repo, idx, target))

    ok = all(p for _, p in checks)
    for name, p in checks:
        print(f"  [{'PASS' if p else 'FAIL'}] {name}")
    print(f"SELF-CHECK {'PASS' if ok else 'FAIL'} ({sum(p for _, p in checks)}/{len(checks)})")
    return 0 if ok else 1


def compute_metrics(spans, attr, G, repo):
    DG = _digraph(G)
    N = nx.condensation(DG).number_of_nodes()
    sccs = sorted((sorted(c) for c in nx.strongly_connected_components(DG) if len(c) > 1),
                  key=lambda c: (-len(c), c))
    idx = _contract_index(repo)
    seam_set, contract_ok, unresolved = defaultdict(bool), defaultdict(bool), set()
    for s in spans:
        k = _norm_op(s["name"])
        if s["seam"]:
            seam_set[k] = True
        if s["contract"]:
            if _resolve_contract(repo, idx, s["contract"]):
                contract_ok[k] = True
            else:
                unresolved.add((k, s["contract"]))
    # C = seams the author has CLASSIFIED: seam.kind set AND a resolving contract.id
    C = sum(1 for k in contract_ok if contract_ok[k] and seam_set.get(k))
    return {"N": N, "C": C, "sccs": sccs, "unresolved": sorted(unresolved)}


def check_baseline(spans, attr, G, repo, path):
    m = compute_metrics(spans, attr, G, repo)
    b = json.load(open(path))
    fails = []
    # 1. N rose — unless explained by sanctioned clean SCC-breaks
    if m["N"] > b.get("N", 1 << 30):
        cur = [frozenset(c) for c in m["sccs"]]
        allowed = 0
        for bs in b.get("broken_sccs", []):
            bset = frozenset(bs)
            if not any(bset <= cs for cs in cur):     # sanctioned SCC is gone -> credit the split
                allowed += len(bs) - 1
        if m["N"] - b["N"] > allowed:
            fails.append(f"N rose {b['N']} -> {m['N']} (credited clean-break budget {allowed}); "
                         f"new coupling added a condensation node")
    # 2. C fell — an annotation was removed/invalidated
    if m["C"] < b.get("C", 0):
        fails.append(f"C fell {b['C']} -> {m['C']} (a validated contract was removed/invalidated)")
    # 3. unresolved contract.id (rejects TODO and ids that don't resolve to an ACID/SDD/path)
    for k, cid in m["unresolved"]:
        fails.append(f"unresolved contract.id {cid!r} on seam {k} "
                     f"(must resolve to an ACID or repo path)")
    return m, fails


# ===========================================================================
# DOT + timeline (DOT from graph; timeline is inherently span/time-based)
# ===========================================================================

def write_dot(G, static, path, focus):
    DG = _digraph(G)
    invisible = set()
    if static:
        sp = {frozenset(e) if e[0] != e[1] else (e[0],) for e in static[0]}
        pp = static[1]
        for u, v in DG.edges:
            if u.startswith("~") or v.startswith("~"):
                continue
            if (frozenset((u, v)) if u != v else (u,)) in sp:
                continue
            pu, pv = _pkg_of_file(u), _pkg_of_file(v)
            if pu != pv and frozenset((pu, pv)) in pp:
                continue
            invisible.add((u, v))

    def tch(e):
        return not focus or focus in e[0] or focus in e[1]

    keep_e = {e: DG.edges[e]["weight"] for e in DG.edges if tch(e)}
    keep_n = {n for e in keep_e for n in e}
    pal = ["#4e79a7", "#f28e2b", "#59a14f", "#e15759", "#76b7b2", "#edc948", "#b07aa1", "#9c755f"]
    pkgs = sorted({G.nodes[n]["pkg"] for n in keep_n})
    pc = {p: pal[i % len(pal)] for i, p in enumerate(pkgs)}
    mx = max((G.nodes[n]["n_spans"] for n in keep_n), default=1) or 1
    mxe = max(keep_e.values(), default=1) or 1
    out = ['digraph runtime_flow {', '  rankdir=LR; node[shape=box,style="filled,rounded",'
           'fontname=Helvetica,fontsize=10]; edge[fontname=Helvetica,fontsize=8];']
    bypkg = defaultdict(list)
    for n in keep_n:
        bypkg[G.nodes[n]["pkg"]].append(n)
    for i, (p, ns) in enumerate(sorted(bypkg.items())):
        out.append(f'  subgraph cluster_{i} {{ label="{p}"; style=dashed; color="#999";')
        for n in ns:
            pen = 1 + 3 * (G.nodes[n]["n_spans"] / mx)
            out.append(f'    "{n}" [label="{short(n)}\\n{G.nodes[n]["n_spans"]} spans",'
                       f'fillcolor="{pc[p]}33",penwidth={pen:.1f}];')
        out.append("  }")
    for (u, v), c in keep_e.items():
        red = (u, v) in invisible
        out.append(f'  "{u}" -> "{v}" [label="{c}",penwidth={0.5+4*(c/mxe):.1f},'
                   f'color="{"#e15759" if red else "#33333399"}",style={"bold" if red else "solid"}];')
    out.append("}")
    open(path, "w").write("\n".join(out))


def write_timeline(spans, attr, path, lanes_n=22, cols=160):
    name_by_id = {s["id"]: s["name"] for s in spans}
    starts = [s["start"] for s in spans if s["start"]]
    if not starts:
        return None
    t0 = min(starts)
    t1 = max(s["start"] + s["dur"] for s in spans if s["start"])
    span_t = max(t1 - t0, 1.0)
    vol = Counter()
    inf = defaultdict(lambda: [0] * cols)
    outf = defaultdict(lambda: [0] * cols)
    nc = {}

    def node(nm):
        if nm not in nc:
            nc[nm] = attr.node(nm)[0]
        return nc[nm]

    for s in spans:
        if not s["start"]:
            continue
        n = node(s["name"])
        vol[n] += 1
        b = min(cols - 1, int((s["start"] - t0) / span_t * cols))
        p = s["parent"]
        pn = node(name_by_id[p]) if p in name_by_id else None
        if pn and pn != n:
            inf[n][b] += 1
            outf[pn][b] += 1
    lanes = [n for n, _ in vol.most_common(lanes_n)]
    lanes.sort(key=lambda n: next((i for i in range(cols) if inf[n][i] or outf[n][i]), 0))
    cw, lh, lblw, tp = 7, 22, 360, 40
    W, H = lblw + cols * cw + 20, tp + len(lanes) * lh + 30
    mx = max((max(max(inf[n]), max(outf[n])) for n in lanes), default=1) or 1

    def esc(x):
        return x.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
           f'font-family="Helvetica" font-size="10"><rect width="{W}" height="{H}" fill="white"/>',
           f'<text x="8" y="18" font-size="13" font-weight="bold">Runtime flow over time (LTR) — '
           f'blue=net inflow, orange=net outflow</text>',
           f'<text x="8" y="32" fill="#666">{len(spans)} spans · {span_t/1000:.0f}s · lanes by first activity</text>']
    for li, n in enumerate(lanes):
        y = tp + li * lh
        out.append(f'<text x="{lblw-6}" y="{y+lh-7}" text-anchor="end">{esc(short(n))[:54]}</text>')
        out.append(f'<rect x="{lblw}" y="{y}" width="{cols*cw}" height="{lh-2}" fill="#fafafa" stroke="#eee"/>')
        for b in range(cols):
            i, o = inf[n][b], outf[n][b]
            if not i and not o:
                continue
            net = o - i
            inten = min(1.0, (abs(net) + 0.4 * min(i, o)) / mx) ** 0.5
            col = "#e8821e" if net > 0 else "#2b7bba" if net < 0 else "#999"
            out.append(f'<rect x="{lblw+b*cw}" y="{y+1}" width="{cw-0.5:.1f}" height="{lh-4}" '
                       f'fill="{col}" opacity="{0.12+0.85*inten:.2f}"/>')
    out.append("</svg>")
    open(path, "w").write("\n".join(out))
    return {"lanes": len(lanes), "wall_s": span_t / 1000}


# ===========================================================================
# main
# ===========================================================================

def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    flags = {}
    for a in argv[1:]:
        if a.startswith("--"):
            k, _, v = a[2:].partition("=")
            flags[k] = v if v else True
    repo = flags.get("repo", ".")
    if flags.get("self-check"):
        return _self_check(repo)
    if not args:
        print(__doc__)
        return 2
    gran = flags.get("granularity", "file")
    focus = flags.get("focus") or None
    top = int(flags.get("top", 15))

    emap = build_emission_map(repo)
    attr = Attributor(emap, gran)
    spans, bad = load_spans(args)
    if not spans:
        print("no spans", file=sys.stderr)
        return 2
    G = build_graph(spans, attr)
    static = load_static(flags["depcruise"], gran) if flags.get("depcruise") \
        and os.path.exists(flags["depcruise"]) else None

    print(f"# emission sites {len(emap)}  spans {len(spans)} from {len(args)} trace(s)  "
          f"nodes {G.number_of_nodes()}  bad {bad}", file=sys.stderr)

    # deterministic gate / baseline ops short-circuit the human reports
    if flags.get("write-baseline"):
        m = compute_metrics(spans, attr, G, repo)
        json.dump({"N": m["N"], "C": m["C"], "broken_sccs": []},
                  open(flags["write-baseline"], "w"), indent=2)
        open(flags["write-baseline"], "a").write("\n")
        print(f"wrote {flags['write-baseline']}: N={m['N']} C={m['C']} "
              f"(multi-node SCCs: {len(m['sccs'])})")
        return 0
    if flags.get("check-baseline"):
        m, fails = check_baseline(spans, attr, G, repo, flags["check-baseline"])
        print(f"N={m['N']} C={m['C']} multi-node-SCCs={len(m['sccs'])} "
              f"unresolved-contracts={len(m['unresolved'])}")
        if fails:
            print("GATE FAIL:")
            for f in fails:
                print(f"  - {f}")
            return 1
        print("GATE PASS")
        return 0

    print(report_flow(G, top, focus))
    if static:
        print(report_overlay(G, static, top, focus))
    if flags.get("contracts"):
        print(report_contracts(spans, attr, G, top))
    if flags.get("skeleton"):
        print(report_skeleton(G, top))
    if flags.get("coverage") and static:
        print(report_coverage(G, static, top))
    if flags.get("dot"):
        write_dot(G, static, flags["dot"], focus)
        print(f"\n# DOT: {flags['dot']} (dot -Tsvg {flags['dot']} -o flow.svg)", file=sys.stderr)
    if flags.get("timeline"):
        info = write_timeline(spans, attr, flags["timeline"])
        if info:
            print(f"# timeline: {flags['timeline']} ({info['lanes']} lanes, {info['wall_s']:.0f}s)",
                  file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
