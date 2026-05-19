// Codebase type catalog + static composition map. Mechanical, not a plan.
//
// One ts-morph Project over ALL packages/*/src + apps/*/src (tests,
// *.d.ts, generated, node_modules, repos/effect excluded). Cross-package
// symbol resolution is via a synthesized tsconfig `paths` map built from
// each package.json `exports` (no node_modules dependency for OUR types).
// External libs (effect, @effect/*) resolve through the symlinked
// node_modules; references that still don't resolve (as-casts, dynamic
// dispatch) are COUNTED and reported, never silently dropped.
//
// Emits: catalog.json, type-composition.dot (+ full.dot if filtered),
// service-deps.dot, per-package/<pkg>/types.dot, summary.md.
import { Project, Node, SyntaxKind, ts } from "ts-morph";
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const OUT = "tooling/analysis/type-map";
mkdirSync(join(ROOT, OUT, "per-package"), { recursive: true });

// ── 1. package map → synthesized paths ──────────────────────────────
type Pkg = { name: string; dir: string; root: "packages" | "apps" };
const pkgs: Pkg[] = [];
const paths: Record<string, string[]> = {};
for (const root of ["packages", "apps"] as const) {
  if (!existsSync(join(ROOT, root))) continue;
  for (const d of readdirSync(join(ROOT, root))) {
    const pj = join(ROOT, root, d, "package.json");
    if (!existsSync(pj)) continue;
    const p = JSON.parse(readFileSync(pj, "utf8"));
    if (!p.name) continue;
    pkgs.push({ name: p.name, dir: join(root, d), root });
    const ex = p.exports ?? {};
    for (const k of Object.keys(ex)) {
      const v = ex[k];
      const t = typeof v === "string" ? v : v?.types ?? v?.default;
      if (!t) continue;
      const spec = k === "." ? p.name : `${p.name}/${k.replace(/^\.\//, "")}`;
      paths[spec] = [join(root, d, t.replace(/^\.\//, ""))];
    }
  }
}
const pkgOf = (fp: string): string => {
  const r = relative(ROOT, fp);
  const m = r.match(/^(packages|apps)\/([^/]+)\//);
  return m ? `${m[1]}/${m[2]}` : "?";
};

// ── 2. project ──────────────────────────────────────────────────────
const project = new Project({
  skipAddingFilesFromTsConfig: true,
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    esModuleInterop: true,
    resolveJsonModule: true,
    baseUrl: ROOT,
    paths,
    types: [],
  },
});
project.addSourceFilesAtPaths([
  "packages/*/src/**/*.ts",
  "packages/*/src/**/*.tsx",
  "apps/*/src/**/*.ts",
  "apps/*/src/**/*.tsx",
  "!**/*.test.ts",
  "!**/*.test.tsx",
  "!**/*.spec.ts",
  "!**/*.d.ts",
  "!**/test/**",
  "!**/__tests__/**",
  "!**/*.gen.ts",
  "!**/generated/**",
]);

// ── 3. classify declarations ────────────────────────────────────────
type Kind =
  | "type-alias" | "interface" | "context-tag" | "schema-tagged-class"
  | "schema-struct" | "schema-union" | "workflow" | "layer-instance" | "other";
type Rec = {
  id: string; name: string; kind: Kind; pkg: string;
  file: string; startLine: number; endLine: number; detail: string;
};
const recs: Rec[] = [];
const nodeId = new Map<Node, string>();          // decl node → id
const byName = new Map<string, string[]>();      // bare name → ids (collision-aware)

const TAGEXT = /\b(Context\.(Tag|Reference|GenericTag)|Effect\.(Tag|Service))\b/;
const SCHEMACLASS = /\bSchema\.(TaggedClass|TaggedError|TaggedRequest|Class)\b/;
const truncate = (s: string, n = 140) =>
  s.replace(/\s+/g, " ").trim().slice(0, n);

const add = (
  name: string, kind: Kind, node: Node, sf: string, detail: string,
) => {
  const pkg = pkgOf(sf);
  const id = `${pkg}::${name}`;
  if (nodeId.has(node)) return;
  const rec: Rec = {
    id, name, kind, pkg,
    file: relative(ROOT, sf),
    startLine: node.getStartLineNumber(),
    endLine: node.getEndLineNumber(),
    detail: truncate(detail),
  };
  recs.push(rec);
  nodeId.set(node, id);
  (byName.get(name) ?? byName.set(name, []).get(name)!).push(id);
};

for (const sf of project.getSourceFiles()) {
  const fp = sf.getFilePath();
  if (!/\/(packages|apps)\/[^/]+\/src\//.test(fp)) continue;

  for (const i of sf.getInterfaces())
    add(i.getName(), "interface", i, fp,
      `extends ${i.getExtends().map((e) => e.getText()).join(", ") || "—"}`);

  for (const t of sf.getTypeAliases()) {
    const rhs = t.getTypeNode()?.getText() ?? "";
    const kind: Kind = /\bSchema\.Union\b|\|/.test(rhs) && /Schema\./.test(rhs)
      ? "schema-union" : "type-alias";
    add(t.getName(), kind, t, fp, rhs);
  }

  for (const c of sf.getClasses()) {
    const name = c.getName();
    if (!name) continue;
    const ext = c.getExtends()?.getText() ?? "";
    const kind: Kind =
      TAGEXT.test(ext) ? "context-tag"
      : SCHEMACLASS.test(ext) ? "schema-tagged-class"
      : "other";
    add(name, kind, c, fp, ext ? `extends ${ext}` : "class");
  }

  for (const v of sf.getVariableDeclarations()) {
    const name = v.getName();
    const init = v.getInitializer()?.getText() ?? "";
    const ann = v.getTypeNode()?.getText() ?? "";
    let kind: Kind | null = null;
    if (TAGEXT.test(init) || /\bContext\.GenericTag\b/.test(init)) kind = "context-tag";
    else if (SCHEMACLASS.test(init)) kind = "schema-tagged-class";
    else if (/\bSchema\.Union\b/.test(init)) kind = "schema-union";
    else if (/\bSchema\.(Struct|struct|TaggedStruct)\b/.test(init)) kind = "schema-struct";
    else if (/\b(Workflow\.(make|define)|makeDurableWorkflow|defineWorkflow|DurableWorkflow\.make)\b/.test(init)) kind = "workflow";
    else if (/^Layer\.[A-Za-z]/.test(init) || /\bLayer\.Layer<|\bLayer\.Layer\b/.test(ann)) kind = "layer-instance";
    if (kind) add(name, kind, v, fp, truncate(init || ann));
  }

  for (const e of sf.getEnums()) add(e.getName(), "other", e, fp, "enum");
}

// ── 4. composition edges (symbol resolution; honest about misses) ────
const declNames = new Set(byName.keys());
const compEdges = new Set<string>();             // "id->id"
let resolvedRefs = 0, unresolvedNamedRefs = 0;
const unresolvedSamples: string[] = [];

const idOfNode = (n: Node | undefined): string | undefined => {
  if (!n) return undefined;
  // climb to the declaration node we catalogued
  let cur: Node | undefined = n;
  for (let i = 0; cur && i < 6; i++) {
    if (nodeId.has(cur)) return nodeId.get(cur);
    cur = cur.getParent();
  }
  return undefined;
};

for (const [node, fromId] of nodeId) {
  node.forEachDescendant((d) => {
    if (!Node.isIdentifier(d)) return;
    const txt = d.getText();
    if (!declNames.has(txt)) return;             // fast pre-filter
    // skip the declaration's own name node
    const p = d.getParent();
    if (p && (Node.isClassDeclaration(p) || Node.isInterfaceDeclaration(p) ||
      Node.isTypeAliasDeclaration(p) || Node.isVariableDeclaration(p) ||
      Node.isEnumDeclaration(p)) && (p as any).getNameNode?.() === d) return;
    let toId: string | undefined;
    try {
      const defs = d.getDefinitionNodes();
      for (const def of defs) {
        toId = idOfNode(def);
        if (toId) break;
      }
    } catch { /* resolution threw — treat as unresolved */ }
    if (toId) {
      resolvedRefs++;
      if (toId !== fromId) compEdges.add(`${fromId}->${toId}`);
    } else {
      unresolvedNamedRefs++;
      if (unresolvedSamples.length < 25)
        unresolvedSamples.push(`${fromId} → "${txt}" @ ${relative(ROOT, d.getSourceFile().getFilePath())}:${d.getStartLineNumber()}`);
    }
  });
}

// ── 5. service-dependency edges (Tag → tags yielded in its Live) ─────
const tagIds = new Set(recs.filter((r) => r.kind === "context-tag").map((r) => r.id));
const tagByName = new Map<string, string>();
for (const r of recs) if (r.kind === "context-tag") tagByName.set(r.name, r.id);
const svcEdges = new Set<string>();
for (const sf of project.getSourceFiles()) {
  if (!/\/(packages|apps)\/[^/]+\/src\//.test(sf.getFilePath())) continue;
  sf.forEachDescendant((n) => {
    if (!Node.isCallExpression(n)) return;
    if (!/^Layer\.(effect|scoped|succeed|sync|effectDiscard)$/.test(n.getExpression().getText())) return;
    const args = n.getArguments();
    const provided = args[0]?.getText().replace(/<.*/, "").trim();
    if (!provided || !tagByName.has(provided)) return;
    const fromId = tagByName.get(provided)!;
    const body = args[1]?.getText() ?? "";
    for (const [tname, tid] of tagByName) {
      if (tid === fromId) continue;
      if (new RegExp(`yield\\*\\s+${tname}\\b|\\b${tname}\\.pipe|provide\\w*\\([^)]*\\b${tname}\\b`).test(body))
        svcEdges.add(`${fromId}->${tid}`);
    }
  });
}

// ── 6. cycle detection (Tarjan SCC), reused for both graphs ──────────
const sccOf = (edges: Set<string>): string[][] => {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const [a, b] = e.split("->");
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
  }
  let idx = 0;
  const I = new Map<string, number>(), L = new Map<string, number>();
  const on = new Set<string>(), stk: string[] = [], out: string[][] = [];
  const strong = (v: string) => {
    I.set(v, idx); L.set(v, idx); idx++; stk.push(v); on.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!I.has(w)) { strong(w); L.set(v, Math.min(L.get(v)!, L.get(w)!)); }
      else if (on.has(w)) L.set(v, Math.min(L.get(v)!, I.get(w)!));
    }
    if (L.get(v) === I.get(v)) {
      const c: string[] = []; let w: string;
      do { w = stk.pop()!; on.delete(w); c.push(w); } while (w !== v);
      if (c.length > 1 || (adj.get(v) ?? []).includes(v)) out.push(c);
    }
  };
  for (const v of adj.keys()) if (!I.has(v)) strong(v);
  return out;
};
const compCycles = sccOf(compEdges);
const svcCycles = sccOf(svcEdges);

// ── 7. emit ─────────────────────────────────────────────────────────
const recById = new Map(recs.map((r) => [r.id, r]));
const refCount = new Map<string, number>();
for (const e of compEdges) {
  const to = e.split("->")[1];
  refCount.set(to, (refCount.get(to) ?? 0) + 1);
}
const palette = ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
  "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf"];
const pkgList = [...new Set(recs.map((r) => r.pkg))].sort();
const colorOf = (pkg: string) => palette[pkgList.indexOf(pkg) % palette.length];
const q = (s: string) => `"${s.replace(/"/g, "'")}"`;

writeFileSync(join(ROOT, OUT, "catalog.json"), JSON.stringify({
  generated: new Date().toISOString(),
  root: ROOT,
  packages: pkgs.map((p) => p.dir),
  counts: {
    declared: recs.length,
    compositionEdges: compEdges.size,
    serviceEdges: svcEdges.size,
    resolvedRefs, unresolvedNamedRefs,
  },
  resolutionCaveat:
    "unresolvedNamedRefs = identifiers matching a declared type name whose " +
    "symbol could not be resolved to a catalogued declaration (as-casts, " +
    "dynamic dispatch, re-export indirection, or external collisions). " +
    "These are NOT edges. Sample in summary.md.",
  records: recs.sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine),
}, null, 2));

const dotGraph = (
  nodes: string[], edges: Iterable<string>, redSet: Set<string>,
): string => [
  "digraph types {",
  "  rankdir=LR; node [shape=box,fontsize=9,style=filled];",
  ...nodes.map((id) => {
    const r = recById.get(id)!;
    const red = redSet.has(id);
    return `  ${q(id)} [fillcolor="${red ? "#ffd5d5" : "#ffffff"}",`
      + `color="${red ? "#d62728" : colorOf(r.pkg)}",penwidth=${red ? 2 : 1},`
      + `label=${q(`${r.name}\\n(${r.kind})`)}];`;
  }),
  ...[...edges].map((e) => { const [a, b] = e.split("->"); return `  ${q(a)} -> ${q(b)};`; }),
  "}",
].join("\n");

const compCycleNodes = new Set(compCycles.flat());
const fullNodes = recs.map((r) => r.id);
writeFileSync(join(ROOT, OUT, "full.dot"),
  dotGraph(fullNodes, compEdges, compCycleNodes));
// headline: fits-on-screen filter when the full graph is large
let headNodes = fullNodes, headEdges = compEdges, filtered = false;
if (fullNodes.length > 500) {
  filtered = true;
  const keep = new Set(recs.filter((r) => (refCount.get(r.id) ?? 0) >= 3).map((r) => r.id));
  headNodes = [...keep];
  headEdges = new Set([...compEdges].filter((e) => {
    const [a, b] = e.split("->"); return keep.has(a) && keep.has(b);
  }));
}
writeFileSync(join(ROOT, OUT, "type-composition.dot"),
  dotGraph(headNodes, headEdges, compCycleNodes));

const svcCycleNodes = new Set(svcCycles.flat());
writeFileSync(join(ROOT, OUT, "service-deps.dot"),
  dotGraph([...tagIds], svcEdges, svcCycleNodes));

// per-package subgraphs: local nodes solid, externally-referenced dashed
for (const pkg of pkgList) {
  const local = new Set(recs.filter((r) => r.pkg === pkg).map((r) => r.id));
  const touch = new Set<string>(local);
  const edges = new Set<string>();
  for (const e of compEdges) {
    const [a, b] = e.split("->");
    if (local.has(a) || local.has(b)) { edges.add(e); touch.add(a); touch.add(b); }
  }
  const lines = [
    "digraph pkg {",
    "  rankdir=LR; node [shape=box,fontsize=9,style=filled];",
    ...[...touch].map((id) => {
      const r = recById.get(id)!;
      const isLocal = local.has(id);
      return `  ${q(id)} [fillcolor="${isLocal ? "#ffffff" : "#f0f0f0"}",`
        + `style="${isLocal ? "filled" : "filled,dashed"}",`
        + `color="${colorOf(r.pkg)}",label=${q(`${r.name}\\n(${r.kind}${isLocal ? "" : " · ext"})`)}];`;
    }),
    ...[...edges].map((e) => { const [a, b] = e.split("->"); return `  ${q(a)} -> ${q(b)};`; }),
    "}",
  ];
  const safe = pkg.replace(/\//g, "__");
  mkdirSync(join(ROOT, OUT, "per-package", safe), { recursive: true });
  writeFileSync(join(ROOT, OUT, "per-package", safe, "types.dot"), lines.join("\n"));
}

// ── summary.md ──────────────────────────────────────────────────────
const byKind = new Map<string, number>();
const byPkg = new Map<string, number>();
const kindByPkg = new Map<string, Map<string, number>>();
for (const r of recs) {
  byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
  byPkg.set(r.pkg, (byPkg.get(r.pkg) ?? 0) + 1);
  const m = kindByPkg.get(r.pkg) ?? kindByPkg.set(r.pkg, new Map()).get(r.pkg)!;
  m.set(r.kind, (m.get(r.kind) ?? 0) + 1);
}
const topRefd = [...refCount.entries()]
  .sort((a, b) => b[1] - a[1]).slice(0, 20)
  .map(([id, n]) => `| \`${id}\` | ${recById.get(id)?.kind} | ${n} |`);

// referenced from tiny-firegrid (any tiny-firegrid decl → referent)
const tinyRefs = new Map<string, number>();
for (const e of compEdges) {
  const [a, b] = e.split("->");
  if (recById.get(a)?.pkg === "packages/tiny-firegrid" && recById.get(b)?.pkg !== "packages/tiny-firegrid")
    tinyRefs.set(b, (tinyRefs.get(b) ?? 0) + 1);
}
const topTiny = [...tinyRefs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
  .map(([id, n]) => `| \`${id}\` | ${recById.get(id)?.kind} | ${n} |`);

// protocol types never referenced outside protocol
const protocolIds = recs.filter((r) => r.pkg === "packages/protocol").map((r) => r.id);
const refdFromOutsideProtocol = new Set<string>();
for (const e of compEdges) {
  const [a, b] = e.split("->");
  if (recById.get(b)?.pkg === "packages/protocol" && recById.get(a)?.pkg !== "packages/protocol")
    refdFromOutsideProtocol.add(b);
}
const protocolInternalOnly = protocolIds.filter((id) => !refdFromOutsideProtocol.has(id));

// host-sdk types referenced from apps/ or other consumer packages
const hostSdkConsumed = new Set<string>();
for (const e of compEdges) {
  const [a, b] = e.split("->");
  const rb = recById.get(b), ra = recById.get(a);
  if (rb?.pkg === "packages/host-sdk" && ra && ra.pkg !== "packages/host-sdk" &&
    (ra.pkg.startsWith("apps/") || ra.pkg.startsWith("packages/")))
    hostSdkConsumed.add(`${b}  ← ${a}`);
}

// max composition depth (longest path in the DAG of SCC-condensed graph)
const adj = new Map<string, string[]>();
for (const e of compEdges) {
  const [a, b] = e.split("->");
  (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
}
const memo = new Map<string, number>();
const seen = new Set<string>();
const depth = (v: string): number => {
  if (memo.has(v)) return memo.get(v)!;
  if (seen.has(v)) return 0;                     // cycle guard
  seen.add(v);
  let best = 0;
  for (const w of adj.get(v) ?? []) best = Math.max(best, 1 + depth(w));
  seen.delete(v);
  memo.set(v, best);
  return best;
};
let maxDepth = 0, maxDepthNode = "";
for (const id of fullNodes) {
  const dd = depth(id);
  if (dd > maxDepth) { maxDepth = dd; maxDepthNode = id; }
}

const md = `# Type Catalog & Composition Map — Summary

Generated ${new Date().toISOString()}. Mechanical static map. No
interpretation, no remediation — what is declared and what references
what. Artifacts: \`catalog.json\`, \`type-composition.dot\` (headline${filtered ? ", filtered" : ""}),
\`full.dot\` (every node), \`service-deps.dot\`, \`per-package/<pkg>/types.dot\`.

## Resolution honesty

- Resolved type references: **${resolvedRefs}**
- Name-matched but **unresolved** among visited identifier nodes (not
  edges): **${unresolvedNamedRefs}** — \`as\`-casts, dynamic dispatch,
  re-export indirection, or a name colliding with an external symbol
  that ts-morph could not point at a catalogued declaration.
- **Lower-bound caveat.** The composition graph is built by resolving
  *identifier* nodes whose text matches a declared name. References that
  the syntactic traversal never reaches as a bare identifier — string-
  literal types, mapped/conditional/template-literal type indirection,
  declaration-merged augmentations, and anything elided by inference —
  are not counted at all (neither resolved nor unresolved). Edge counts
  are a floor, not a census. \`unresolvedNamedRefs = 0\` means every
  *name-matched identifier* resolved, not that every reference was seen.
- Cross-package resolution uses a \`paths\` map synthesized from each
  \`package.json\` \`exports\`. Runtime layer composition (\`Layer.merge\`,
  built layers) is **out of scope** — static type composition only.

Unresolved sample (first ${unresolvedSamples.length}):

\`\`\`
${unresolvedSamples.join("\n") || "(none)"}
\`\`\`

## Declared types by kind

| kind | count |
|---|---|
${[...byKind.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `| ${k} | ${n} |`).join("\n")}
| **total** | **${recs.length}** |

## Declared types by package

| package | count | kinds |
|---|---|---|
${[...byPkg.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) =>
  `| ${p} | ${n} | ${[...(kindByPkg.get(p) ?? new Map())].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k}:${c}`).join(", ")} |`).join("\n")}

## Top 20 most-referenced types (codebase-wide)

| type | kind | referrers |
|---|---|---|
${topRefd.join("\n") || "| (none) | | |"}

## Top 20 types referenced from \`packages/tiny-firegrid\`

| type | kind | refs from tiny-firegrid |
|---|---|---|
${topTiny.join("\n") || "| (none) | | |"}

## \`packages/protocol\` types never referenced outside protocol

${protocolInternalOnly.length} of ${protocolIds.length} protocol declarations are
internal-only (no resolved cross-package referrer):

${protocolInternalOnly.slice(0, 60).map((id) => `- \`${id}\` (${recById.get(id)?.kind})`).join("\n") || "(none)"}
${protocolInternalOnly.length > 60 ? `\n…and ${protocolInternalOnly.length - 60} more (see catalog.json).` : ""}

## \`packages/host-sdk\` types referenced from apps/ or consumer packages

${hostSdkConsumed.size} cross-package consumption edges into host-sdk:

${[...hostSdkConsumed].slice(0, 60).map((s) => `- \`${s}\``).join("\n") || "(none)"}
${hostSdkConsumed.size > 60 ? `\n…and ${hostSdkConsumed.size - 60} more.` : ""}

## Cycles

- type-composition: **${compCycles.length}** strongly-connected component(s) with >1 node or a self-loop.
${compCycles.slice(0, 15).map((c) => `  - { ${c.join(", ")} }`).join("\n") || "  - (none)"}
- service-deps: **${svcCycles.length}** SCC(s).
${svcCycles.slice(0, 15).map((c) => `  - { ${c.join(", ")} }`).join("\n") || "  - (none)"}

## Maximum composition depth

Longest resolved referrer→referent path: **${maxDepth}** edges, from
\`${maxDepthNode}\` (cycle-guarded; condensed over SCCs).
`;
writeFileSync(join(ROOT, OUT, "summary.md"), md.replace(/[ \t]+$/gm, ""));

console.log(JSON.stringify({
  declared: recs.length, byKind: Object.fromEntries(byKind),
  compEdges: compEdges.size, svcEdges: svcEdges.size,
  resolvedRefs, unresolvedNamedRefs,
  compCycles: compCycles.length, svcCycles: svcCycles.length,
  maxDepth, filtered,
}, null, 2));
