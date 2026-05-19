// Analysis C — tiny-firegrid reach subgraph. Mechanical, not a plan.
//
// Recomputes the type-composition edges with the SAME id scheme as
// build-type-map.ts, takes every type declared in packages/tiny-firegrid
// as a root, and forward-closes the composition graph (referrer→referent)
// to the set tiny-firegrid transitively exercises. Joins B's PUBLIC
// classification from catalog.json to report, per package: % of PUBLIC
// surface reached, substrate PUBLIC types NOT reached (coverage gaps),
// and reached-but-not-PUBLIC (internals tiny-firegrid reaches into).
// No interpretation, no remediation.
import { Project, Node, ts } from "ts-morph";
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const OUT = "tooling/analysis/type-map";
const TINY = "packages/tiny-firegrid";

// ── project + declarations + edges (mirror of build-type-map.ts) ────
const paths: Record<string, string[]> = {};
for (const root of ["packages", "apps"] as const) {
  if (!existsSync(join(ROOT, root))) continue;
  for (const d of readdirSync(join(ROOT, root))) {
    const pj = join(ROOT, root, d, "package.json");
    if (!existsSync(pj)) continue;
    const p = JSON.parse(readFileSync(pj, "utf8"));
    if (!p.name) continue;
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
  const m = relative(ROOT, fp).match(/^(packages|apps)\/([^/]+)\//);
  return m ? `${m[1]}/${m[2]}` : "?";
};
const project = new Project({
  skipAddingFilesFromTsConfig: true,
  compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true, strict: true, skipLibCheck: true,
    noEmit: true, esModuleInterop: true, resolveJsonModule: true,
    baseUrl: ROOT, paths, types: [],
  },
});
project.addSourceFilesAtPaths([
  "packages/*/src/**/*.ts", "packages/*/src/**/*.tsx",
  "apps/*/src/**/*.ts", "apps/*/src/**/*.tsx",
  "!**/*.test.ts", "!**/*.test.tsx", "!**/*.spec.ts", "!**/*.d.ts",
  "!**/test/**", "!**/__tests__/**", "!**/*.gen.ts", "!**/generated/**",
]);

type Kind = string;
const nodeId = new Map<Node, string>();
const idMeta = new Map<string, { name: string; pkg: string; kind: Kind }>();
const declNames = new Set<string>();
const TAGEXT = /\b(Context\.(Tag|Reference|GenericTag)|Effect\.(Tag|Service))\b/;
const SCHEMACLASS = /\bSchema\.(TaggedClass|TaggedError|TaggedRequest|Class)\b/;
const reg = (name: string, kind: Kind, node: Node, sf: string) => {
  const pkg = pkgOf(sf); const id = `${pkg}::${name}`;
  if (nodeId.has(node) || idMeta.has(id)) return;
  nodeId.set(node, id); idMeta.set(id, { name, pkg, kind }); declNames.add(name);
};
for (const sf of project.getSourceFiles()) {
  const fp = sf.getFilePath();
  if (!/\/(packages|apps)\/[^/]+\/src\//.test(fp)) continue;
  for (const i of sf.getInterfaces()) reg(i.getName(), "interface", i, fp);
  for (const t of sf.getTypeAliases()) {
    const rhs = t.getTypeNode()?.getText() ?? "";
    reg(t.getName(), /\bSchema\.Union\b|\|/.test(rhs) && /Schema\./.test(rhs) ? "schema-union" : "type-alias", t, fp);
  }
  for (const c of sf.getClasses()) {
    const name = c.getName(); if (!name) continue;
    const ext = c.getExtends()?.getText() ?? "";
    reg(name, TAGEXT.test(ext) ? "context-tag" : SCHEMACLASS.test(ext) ? "schema-tagged-class" : "other", c, fp);
  }
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer()?.getText() ?? "";
    const ann = v.getTypeNode()?.getText() ?? "";
    let kind: Kind | null = null;
    if (TAGEXT.test(init) || /\bContext\.GenericTag\b/.test(init)) kind = "context-tag";
    else if (SCHEMACLASS.test(init)) kind = "schema-tagged-class";
    else if (/\bSchema\.Union\b/.test(init)) kind = "schema-union";
    else if (/\bSchema\.(Struct|struct|TaggedStruct)\b/.test(init)) kind = "schema-struct";
    else if (/\b(Workflow\.(make|define)|makeDurableWorkflow|defineWorkflow|DurableWorkflow\.make)\b/.test(init)) kind = "workflow";
    else if (/^Layer\.[A-Za-z]/.test(init) || /\bLayer\.Layer\b/.test(ann)) kind = "layer-instance";
    if (kind) reg(v.getName(), kind, v, fp);
  }
  for (const e of sf.getEnums()) reg(e.getName(), "other", e, fp);
}

const idOfNode = (n: Node | undefined): string | undefined => {
  let cur: Node | undefined = n;
  for (let i = 0; cur && i < 6; i++) { if (nodeId.has(cur)) return nodeId.get(cur); cur = cur.getParent(); }
  return undefined;
};
const edges = new Set<string>();
for (const [node, fromId] of nodeId) {
  node.forEachDescendant((d) => {
    if (!Node.isIdentifier(d)) return;
    if (!declNames.has(d.getText())) return;
    const p = d.getParent();
    if (p && (Node.isClassDeclaration(p) || Node.isInterfaceDeclaration(p) ||
      Node.isTypeAliasDeclaration(p) || Node.isVariableDeclaration(p) ||
      Node.isEnumDeclaration(p)) && (p as any).getNameNode?.() === d) return;
    try {
      for (const def of d.getDefinitionNodes()) {
        const toId = idOfNode(def);
        if (toId) { if (toId !== fromId) edges.add(`${fromId}->${toId}`); break; }
      }
    } catch { /* unresolved — honest gap, not an edge */ }
  });
}

// ── reach: forward closure from tiny-firegrid roots ─────────────────
const adj = new Map<string, string[]>();
for (const e of edges) { const [a, b] = e.split("->"); (adj.get(a) ?? adj.set(a, []).get(a)!).push(b); }
const roots = [...idMeta.keys()].filter((id) => idMeta.get(id)!.pkg === TINY);
const reached = new Set<string>(roots);
const stack = [...roots];
while (stack.length) {
  const v = stack.pop()!;
  for (const w of adj.get(v) ?? []) if (!reached.has(w)) { reached.add(w); stack.push(w); }
}

// ── join B's PUBLIC classification from catalog.json ────────────────
const cls = new Map<string, string>();
const catPath = join(ROOT, OUT, "catalog.json");
let surfaceJoined = false;
if (existsSync(catPath)) {
  const cat = JSON.parse(readFileSync(catPath, "utf8"));
  for (const r of cat.records ?? []) if (r.classification) cls.set(r.id, r.classification);
  surfaceJoined = cls.size > 0;
}
const isPublic = (id: string) => cls.get(id) === "PUBLIC";

// substrate = packages/* except tiny-firegrid (apps are consumers, excluded)
const substratePkgs = [...new Set([...idMeta.values()].map((m) => m.pkg))]
  .filter((p) => p.startsWith("packages/") && p !== TINY).sort();
const isSubstrate = (id: string) => substratePkgs.includes(idMeta.get(id)?.pkg ?? "");

// ── per-package coverage (of PUBLIC surface) ────────────────────────
const pkgs = [...new Set([...idMeta.values()].map((m) => m.pkg))].sort();
const rows = pkgs.map((p) => {
  const all = [...idMeta.keys()].filter((id) => idMeta.get(id)!.pkg === p);
  const pub = all.filter(isPublic);
  const pubReached = pub.filter((id) => reached.has(id));
  const anyReached = all.filter((id) => reached.has(id));
  const pct = pub.length ? Math.round((pubReached.length / pub.length) * 100) : 0;
  return { p, total: all.length, pub: pub.length, pubReached: pubReached.length, anyReached: anyReached.length, pct };
});

const substrateIds = [...idMeta.keys()].filter(isSubstrate);
const unreachedPublic = substrateIds.filter((id) => isPublic(id) && !reached.has(id)).sort();
const reachedNonPublic = substrateIds.filter((id) => reached.has(id) && cls.has(id) && !isPublic(id)).sort();

// ── DOT (closure subgraph; filter >80; unreached sidebar) ───────────
const palette = ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
  "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf"];
const colorOf = (p: string) => palette[Math.max(0, pkgs.indexOf(p)) % palette.length];
const q = (s: string) => `"${s.replace(/"/g, "'")}"`;
const reachEdges = [...edges].filter((e) => { const [a, b] = e.split("->"); return reached.has(a) && reached.has(b); });
const deg = new Map<string, number>();
for (const e of reachEdges) { const [a, b] = e.split("->"); deg.set(a, (deg.get(a) ?? 0) + 1); deg.set(b, (deg.get(b) ?? 0) + 1); }
const rootSet = new Set(roots);
const drawIds = reached.size > 80
  ? [...reached].filter((id) => rootSet.has(id) || (deg.get(id) ?? 0) >= 2)
  : [...reached];
const drawSet = new Set(drawIds);
const sidebar = unreachedPublic.slice(0, 40).map((id) => idMeta.get(id)?.name ?? id).join("\\l") + "\\l";
const dot = [
  "digraph tinyReach {",
  "  rankdir=LR; node [shape=box,fontsize=9,style=filled];",
  `  label="tiny-firegrid reach — roots double-bordered; sidebar = substrate PUBLIC not reached (first 40 of ${unreachedPublic.length})"; fontsize=10;`,
  ...drawIds.map((id) => {
    const m = idMeta.get(id)!; const root = rootSet.has(id);
    return `  ${q(id)} [fillcolor="${root ? "#fff2cc" : "#ffffff"}",`
      + `color="${colorOf(m.pkg)}",penwidth=${root ? 2 : 1},`
      + `shape=${root ? "doubleoctagon" : "box"},`
      + `label=${q(`${m.name}\\n(${m.pkg.replace(/^packages\//, "")})`)}];`;
  }),
  ...reachEdges.filter((e) => { const [a, b] = e.split("->"); return drawSet.has(a) && drawSet.has(b); })
    .map((e) => { const [a, b] = e.split("->"); return `  ${q(a)} -> ${q(b)} [color="#888888"];`; }),
  `  subgraph cluster_unreached {`,
  `    label="UNREACHED substrate PUBLIC (not drawn)"; style=dashed; color="#d62728";`,
  `    unreached_box [shape=note,fillcolor="#fff0f0",label=${q(sidebar || "(none)")}];`,
  `  }`,
  "}",
].join("\n");
writeFileSync(join(ROOT, OUT, "tiny-firegrid-reach-full.dot"),
  [
    "digraph tinyReachFull {",
    "  rankdir=LR; node [shape=box,fontsize=8,style=filled];",
    ...[...reached].map((id) => { const m = idMeta.get(id)!; return `  ${q(id)} [color="${colorOf(m.pkg)}",label=${q(m.name)}];`; }),
    ...reachEdges.map((e) => { const [a, b] = e.split("->"); return `  ${q(a)} -> ${q(b)};`; }),
    "}",
  ].join("\n"));
writeFileSync(join(ROOT, OUT, "tiny-firegrid-reach.dot"), dot);

// ── summary.md ──────────────────────────────────────────────────────
const covTbl = rows.map((r) =>
  `| ${r.p}${r.p === TINY ? " (roots)" : ""} | ${r.total} | ${r.pub} | ${r.pubReached} | ${r.pct}% | ${r.anyReached} |`).join("\n");
const md = `# Analysis C — tiny-firegrid Reach Subgraph

Generated ${new Date().toISOString()}. Mechanical. Forward closure of the
type-composition graph from every type declared in \`${TINY}\`
(${roots.length} roots). No interpretation, no remediation.

DOT: \`tiny-firegrid-reach.dot\` (closure${reached.size > 80 ? ", filtered to roots + degree ≥ 2" : ""},
unreached substrate PUBLIC in a dashed sidebar), \`tiny-firegrid-reach-full.dot\` (entire closure, ${reached.size} nodes).

## Honesty

- Edges are the same symbol-resolved type-composition edges as the
  initial map (identifier resolution; \`as\`-casts / string-literal /
  mapped-type indirection not traversed — reach is a **lower bound**).
- PUBLIC classification joined from \`catalog.json\` (Analysis B):
  ${surfaceJoined ? "joined" : "**NOT available — run build-surface.ts first**"}.
- "substrate" = \`packages/*\` excluding \`${TINY}\`; apps are consumers
  and excluded. Substrate packages: ${substratePkgs.map((p) => `\`${p}\``).join(", ")}.

## Reach

- tiny-firegrid roots: **${roots.length}**
- total types reached (transitive closure): **${reached.size}**
- of the ${[...idMeta.keys()].length} declared types, that is **${Math.round((reached.size / idMeta.size) * 100)}%**

## Coverage of each package's PUBLIC surface

| package | declared | PUBLIC | PUBLIC reached | % PUBLIC reached | any reached |
|---|---|---|---|---|---|
${covTbl}

## Substrate PUBLIC types NOT reached by tiny-firegrid (coverage gaps)

**${unreachedPublic.length}** substrate public types are never exercised by
the proving ground:

${unreachedPublic.slice(0, 60).map((id) => `- \`${id}\` (${idMeta.get(id)?.kind})`).join("\n") || "(none)"}
${unreachedPublic.length > 60 ? `\n…and ${unreachedPublic.length - 60} more (full list in \`tiny-firegrid-reach-full.dot\` complement / catalog.json).` : ""}

## Substrate types reached that are NOT PUBLIC (reaching into internals)

**${reachedNonPublic.length}** non-public substrate types are reached by the
tiny-firegrid closure (boundary touch — internal symbols exercised
without going through a package entry point):

${reachedNonPublic.slice(0, 60).map((id) => `- \`${id}\` (${cls.get(id)}, ${idMeta.get(id)?.kind})`).join("\n") || "(none)"}
${reachedNonPublic.length > 60 ? `\n…and ${reachedNonPublic.length - 60} more.` : ""}
`;
writeFileSync(join(ROOT, OUT, "tiny-firegrid-reach.md"), md.replace(/[ \t]+$/gm, ""));

console.log(JSON.stringify({
  roots: roots.length, reached: reached.size, declared: idMeta.size,
  substratePkgs, unreachedPublic: unreachedPublic.length,
  reachedNonPublic: reachedNonPublic.length, surfaceJoined,
  drawn: drawIds.length,
}, null, 2));
