// Analysis A — runtime layer-composition graph. Mechanical, not a plan.
//
// Walks Layer.{effect,scoped,succeed,sync,effectDiscard,merge,mergeAll,
// provide,provideMerge,unwrapEffect}. Nodes = named Live layer consts
// (a tag with a producing Layer.effect is represented by that const).
// Edges: producer→layer (effect/scoped requirement), operand→result
// (merge), source→target (provide / provideMerge). Edge style encodes
// the operator. Honest: Layer.unwrapEffect with a computed tag is
// dynamic dispatch — the site is recorded, its produced/consumed tags
// are NOT statically resolved and are flagged.
//
// Reuses the same Project setup as build-type-map.ts (paths synthesized
// from package.json exports; tests/d.ts/generated/node_modules excluded).
import { Project, Node, ts } from "ts-morph";
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const OUT = "tooling/analysis/type-map";
mkdirSync(join(ROOT, OUT), { recursive: true });

// ── project (shared boilerplate) ────────────────────────────────────
const paths: Record<string, string[]> = {};
for (const root of ["packages"] as const) {
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
  const m = relative(ROOT, fp).match(/^packages\/([^/]+)\//);
  return m ? `packages/${m[1]}` : "?";
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
  "!**/*.test.ts", "!**/*.test.tsx", "!**/*.spec.ts", "!**/*.d.ts",
  "!**/test/**", "!**/__tests__/**", "!**/*.gen.ts", "!**/generated/**",
]);

const inScope = (fp: string) => /\/packages\/[^/]+\/src\//.test(fp);
const strip = (s: string) => s.replace(/<[^]*$/, "").replace(/\s+/g, "").trim();
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const loc = (n: Node) =>
  `${relative(ROOT, n.getSourceFile().getFilePath())}:${n.getStartLineNumber()}`;

// ── 1. catalogue named layer consts ─────────────────────────────────
// id = pkg::ConstName. A const is a "layer" if its initializer mentions
// Layer.<ctor>/<combinator> or its type annotation is Layer.Layer<…>.
type LNode = { id: string; name: string; pkg: string; file: string; line: number; kind: string };
const layers = new Map<string, LNode>();          // id → node
const constToId = new Map<string, string>();      // bare const name → id (first decl wins; collisions noted)
const collisions = new Set<string>();
const LAYER_RE = /\bLayer\.(effect|scoped|succeed|sync|effectDiscard|merge|mergeAll|provide|provideMerge|unwrapEffect|unwrapScoped|empty|fresh|catchAll|orElse|tap)\b/;

for (const sf of project.getSourceFiles()) {
  if (!inScope(sf.getFilePath())) continue;
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer()?.getText() ?? "";
    const ann = v.getTypeNode()?.getText() ?? "";
    if (!LAYER_RE.test(init) && !/\bLayer\.Layer\b/.test(ann)) continue;
    const name = v.getName();
    const pkg = pkgOf(sf.getFilePath());
    const id = `${pkg}::${name}`;
    if (layers.has(id)) continue;
    const ctor = init.match(LAYER_RE)?.[1] ?? "composed";
    layers.set(id, {
      id, name, pkg, file: relative(ROOT, sf.getFilePath()),
      line: v.getStartLineNumber(), kind: ctor,
    });
    if (constToId.has(name)) collisions.add(name);
    else constToId.set(name, id);
  }
}

// tag → producing layer const (Layer.effect/scoped/succeed/sync(TAG, …))
const tagToLayer = new Map<string, string>();
for (const sf of project.getSourceFiles()) {
  if (!inScope(sf.getFilePath())) continue;
  sf.forEachDescendant((n) => {
    if (!Node.isCallExpression(n)) return;
    if (!/^Layer\.(effect|scoped|succeed|sync|effectDiscard)$/.test(n.getExpression().getText())) return;
    const tag = strip(n.getArguments()[0]?.getText() ?? "");
    if (!tag) return;
    const vd = n.getFirstAncestorByKind(ts.SyntaxKind.VariableDeclaration);
    const owner = vd ? constToId.get(vd.getName()) : undefined;
    if (owner && !tagToLayer.has(tag)) tagToLayer.set(tag, owner);
  });
}

// ── 2. edges ────────────────────────────────────────────────────────
type Edge = { from: string; to: string; op: "merge" | "provide" | "provideMerge" | "requires"; at: string };
const edges: Edge[] = [];
const seen = new Set<string>();
const pushEdge = (from: string | undefined, to: string | undefined, op: Edge["op"], at: string) => {
  if (!from || !to || from === to) return;
  const k = `${from}|${to}|${op}`;
  if (seen.has(k)) return;
  seen.add(k);
  edges.push({ from, to, op, at });
};

// register a synthetic node (inline anonymous layer) so edges render.
const ensureNode = (id: string, name: string, pkg: string, file: string, line: number, kind: string) => {
  if (!layers.has(id)) layers.set(id, { id, name, pkg, file, line, kind });
  return id;
};
// resolve a layer-valued expression to a node id.
//  identifier            → declaring const (symbol resolution, name fallback)
//  X.pipe(...)           → resolve the pipe head
//  Layer.succeed/effect/scoped/sync(TAG, …) inline → synthetic `inline::TAG`
//  anything else (Layer.merge inline, computed) → undefined (honest gap)
const resolveLayerExpr = (e: Node | undefined): string | undefined => {
  if (!e) return undefined;
  if (Node.isParenthesizedExpression(e)) return resolveLayerExpr(e.getExpression());
  if (Node.isIdentifier(e)) {
    try {
      for (const d of e.getDefinitionNodes()) {
        const vd = Node.isVariableDeclaration(d) ? d
          : d.getFirstAncestorByKind(ts.SyntaxKind.VariableDeclaration);
        if (vd && Node.isVariableDeclaration(vd)) {
          const id = `${pkgOf(vd.getSourceFile().getFilePath())}::${vd.getName()}`;
          if (layers.has(id)) return id;
        }
      }
    } catch { /* unresolved — fall through to name match */ }
    return constToId.get(e.getText());
  }
  if (Node.isCallExpression(e)) {
    const callee = e.getExpression().getText();
    if (/^Layer\.(succeed|effect|scoped|sync|effectDiscard)$/.test(callee)) {
      const tag = strip(e.getArguments()[0]?.getText() ?? "").split(".").pop() ?? "anon";
      const sf = e.getSourceFile();
      return ensureNode(`inline::${tag}`, `inline ${tag}`, pkgOf(sf.getFilePath()),
        relative(ROOT, sf.getFilePath()), e.getStartLineNumber(), "inline");
    }
    const ex = e.getExpression();
    if (Node.isPropertyAccessExpression(ex) && ex.getName() === "pipe")
      return resolveLayerExpr(ex.getExpression());
  }
  return undefined;
};

// the composed-result node for a call: the enclosing layer const, or the
// receiver of the enclosing `.pipe(...)` if the call is a pipe operand.
const resultNodeOf = (n: Node): string | undefined => {
  const vd = n.getFirstAncestorByKind(ts.SyntaxKind.VariableDeclaration);
  if (vd && Node.isVariableDeclaration(vd)) {
    const id = `${pkgOf(vd.getSourceFile().getFilePath())}::${vd.getName()}`;
    if (layers.has(id)) return id;
  }
  // pipe operand: `RECEIVER.pipe( …, thisCall, … )`
  const pipeCall = n.getFirstAncestor((a) =>
    Node.isCallExpression(a) &&
    Node.isPropertyAccessExpression(a.getExpression()) &&
    (a.getExpression() as any).getName() === "pipe");
  if (pipeCall && Node.isCallExpression(pipeCall)) {
    const recv = (pipeCall.getExpression() as any).getExpression?.();
    return resolveLayerExpr(recv);
  }
  return undefined;
};

let unwrapDynamic = 0;
const unwrapSites: string[] = [];
const provideSites: string[] = [];
const provideMergeSites: string[] = [];

for (const sf of project.getSourceFiles()) {
  if (!inScope(sf.getFilePath())) continue;
  sf.forEachDescendant((n) => {
    if (!Node.isCallExpression(n)) return;
    const callee = n.getExpression().getText();
    const args = n.getArguments();
    const at = loc(n);

    // requirement edges (distinct op): Layer.effect(TAG, body) — the
    // layer's Effect requires the tags it yield*-s. NOT a provide-operator
    // use; kept separate so the operator breakdown stays honest.
    if (/^Layer\.(effect|scoped|succeed|sync|effectDiscard)$/.test(callee)) {
      const tag = strip(args[0]?.getText() ?? "");
      const thisLayer = tagToLayer.get(tag);
      const body = args[1]?.getText() ?? "";
      if (thisLayer) {
        for (const [otherTag, otherLayer] of tagToLayer) {
          if (otherLayer === thisLayer) continue;
          const tagPattern = escapeRegExp(otherTag);
          if (new RegExp(`yield\\*\\s+${tagPattern}\\b|\\b${tagPattern}\\.pipe|provide\\w*\\([^)]*\\b${tagPattern}\\b`).test(body))
            pushEdge(otherLayer, thisLayer, "requires", at);
        }
      }
      return;
    }
    // merge / mergeAll: operands (flatten array literal) → enclosing const
    if (/^Layer\.(merge|mergeAll)$/.test(callee)) {
      const result = resultNodeOf(n);
      const operands = args.flatMap((a) =>
        Node.isArrayLiteralExpression(a) ? a.getElements() : [a]);
      for (const a of operands) pushEdge(resolveLayerExpr(a), result, "merge", at);
      return;
    }
    // provide / provideMerge — handles BOTH the data-first two-arg form
    // `Layer.provide(TARGET, SOURCE)` and the dominant pipeable single-arg
    // form `RECEIVER.pipe(Layer.provide(SOURCE), Layer.provideMerge(SRC2))`.
    if (/^Layer\.(provide|provideMerge)$/.test(callee)) {
      const op: Edge["op"] = callee.endsWith("provideMerge") ? "provideMerge" : "provide";
      (op === "provideMerge" ? provideMergeSites : provideSites).push(at);
      let target: string | undefined, source: string | undefined;
      if (args.length >= 2) {            // data-first: provide(TARGET, SOURCE)
        target = resolveLayerExpr(args[0]);
        source = resolveLayerExpr(args[1]);
      } else {                            // pipeable: SOURCE is the only arg
        source = resolveLayerExpr(args[0]);
        target = resultNodeOf(n);
      }
      pushEdge(source, target, op, at);
      return;
    }
    if (/^Layer\.(unwrapEffect|unwrapScoped)$/.test(callee)) {
      unwrapDynamic++;
      if (unwrapSites.length < 40) unwrapSites.push(at);
    }
  });
}

// ── 3. cycles (Tarjan SCC over all edges) ───────────────────────────
const adj = new Map<string, string[]>();
for (const e of edges) (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
let idx = 0;
const I = new Map<string, number>(), L = new Map<string, number>();
const on = new Set<string>(), stk: string[] = [], sccs: string[][] = [];
const strong = (v: string) => {
  I.set(v, idx); L.set(v, idx); idx++; stk.push(v); on.add(v);
  for (const w of adj.get(v) ?? []) {
    if (!I.has(w)) { strong(w); L.set(v, Math.min(L.get(v)!, L.get(w)!)); }
    else if (on.has(w)) L.set(v, Math.min(L.get(v)!, I.get(w)!));
  }
  if (L.get(v) === I.get(v)) {
    const c: string[] = []; let w: string;
    do { w = stk.pop()!; on.delete(w); c.push(w); } while (w !== v);
    if (c.length > 1 || (adj.get(v) ?? []).includes(v)) sccs.push(c);
  }
};
for (const v of adj.keys()) if (!I.has(v)) strong(v);
const cycleNodes = new Set(sccs.flat());

// ── 4. degree + emit DOT ────────────────────────────────────────────
const deg = new Map<string, number>();
for (const e of edges) {
  deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
  deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
}
const palette = ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
  "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf"];
const pkgList = [...new Set([...layers.values()].map((l) => l.pkg))].sort();
const colorOf = (p: string) => palette[Math.max(0, pkgList.indexOf(p)) % palette.length];
const q = (s: string) => `"${s.replace(/"/g, "'")}"`;
const STYLE: Record<Edge["op"], string> = {
  merge: "solid", provide: "dashed", provideMerge: "bold", requires: "dotted",
};
const dot = (nodes: string[], es: Edge[]): string => {
  const ns = new Set(nodes);
  return [
    "digraph layers {",
    "  rankdir=LR; node [shape=box,fontsize=9,style=filled];",
    '  label=" — edge: solid=merge, dashed=provide, bold=provideMerge, dotted=requires ; red=cycle"; fontsize=10;',
    ...nodes.map((id) => {
      const l = layers.get(id);
      const red = cycleNodes.has(id);
      const label = l ? `${l.name}\\n(${l.pkg.replace(/^packages\//, "")})` : id;
      return `  ${q(id)} [fillcolor="${red ? "#ffd5d5" : "#ffffff"}",`
        + `color="${red ? "#d62728" : (l ? colorOf(l.pkg) : "#999999")}",`
        + `penwidth=${red ? 2 : 1},label=${q(label)}];`;
    }),
    ...es.filter((e) => ns.has(e.from) && ns.has(e.to)).map((e) =>
      `  ${q(e.from)} -> ${q(e.to)} [style=${STYLE[e.op]},`
      + `color="${cycleNodes.has(e.from) && cycleNodes.has(e.to) ? "#d62728" : "#555555"}"];`),
    "}",
  ].join("\n");
};

const allIds = [...layers.keys()];
writeFileSync(join(ROOT, OUT, "layer-composition-full.dot"), dot(allIds, edges));
const core = allIds.filter((id) => (deg.get(id) ?? 0) >= 3);
writeFileSync(join(ROOT, OUT, "layer-composition-core.dot"), dot(core, edges));
// headline: full if small, else core (hard constraint: filter >~80)
const headline = allIds.length > 80 ? core : allIds;
writeFileSync(join(ROOT, OUT, "layer-composition.dot"), dot(headline, edges));

// host-build subgraph: transitive closure (both directions) around the
// FiregridRuntimeHost*WithWorkflow* build root, if present.
const hostRoot = [...layers.keys()].find((id) =>
  /FiregridRuntimeHost.*WithWorkflow.*Live|FiregridRuntimeHostWithWorkflowLive/.test(id))
  ?? [...layers.keys()].find((id) => /FiregridRuntimeHost.*Live/.test(id));
const closure = new Set<string>();
if (hostRoot) {
  const fwd = new Map<string, string[]>(), rev = new Map<string, string[]>();
  for (const e of edges) {
    (fwd.get(e.from) ?? fwd.set(e.from, []).get(e.from)!).push(e.to);
    (rev.get(e.to) ?? rev.set(e.to, []).get(e.to)!).push(e.from);
  }
  const bfs = (start: string, g: Map<string, string[]>) => {
    const seenN = new Set([start]); const qn = [start];
    while (qn.length) { const v = qn.shift()!; for (const w of g.get(v) ?? []) if (!seenN.has(w)) { seenN.add(w); qn.push(w); } }
    return seenN;
  };
  for (const x of bfs(hostRoot, fwd)) closure.add(x);
  for (const x of bfs(hostRoot, rev)) closure.add(x);
}
writeFileSync(join(ROOT, OUT, "layer-composition-host-build.dot"),
  dot([...closure], edges.filter((e) => closure.has(e.from) && closure.has(e.to))));

// ── 5. summary.md ───────────────────────────────────────────────────
const byPkg = new Map<string, number>();
for (const l of layers.values()) byPkg.set(l.pkg, (byPkg.get(l.pkg) ?? 0) + 1);
const fanIn = new Map<string, number>(), fanOut = new Map<string, number>();
for (const e of edges) {
  fanIn.set(e.to, (fanIn.get(e.to) ?? 0) + 1);
  fanOut.set(e.from, (fanOut.get(e.from) ?? 0) + 1);
}
const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  .map(([id, n]) => `| \`${id}\` | ${n} |`).join("\n") || "| (none) | |";
const opCount = { merge: 0, provide: 0, provideMerge: 0, requires: 0 };
for (const e of edges) opCount[e.op]++;

const md = `# Analysis A — Layer-Composition Graph

Generated ${new Date().toISOString()}. Mechanical. Runtime layer
composition (which Live layer provides which Tag, what merges into what).
No interpretation, no remediation.

DOT: \`layer-composition.dot\` (headline${allIds.length > 80 ? ", core filter" : ""}),
\`layer-composition-full.dot\` (all ${allIds.length}),
\`layer-composition-core.dot\` (combined degree ≥ 3),
\`layer-composition-host-build.dot\` (${hostRoot ? `closure around \`${hostRoot}\`` : "host root not found"}).
Edge style: solid = \`merge\`, dashed = \`provide\`, bold = \`provideMerge\`,
dotted = \`requires\` (layer-body \`yield* Tag\` dependency, not an operator).

## ts-morph limits (honest)

- \`Layer.unwrapEffect\`/\`unwrapScoped\` (computed/dynamic tag): **${unwrapDynamic}** site(s).
  Produced/consumed tags are NOT statically resolved for these — recorded, not edged.
${unwrapSites.slice(0, 12).map((s) => `  - ${s}`).join("\n") || "  - (none)"}
- Layer operands resolved by identifier→const (symbol resolution, then
  name fallback). Inline anonymous layers and re-export-\* indirection
  that did not resolve are not edged. Const-name collisions across
  packages: ${collisions.size ? [...collisions].join(", ") : "none"}.
- Producer→layer requirement edges are syntactic (\`yield* Tag\` in the
  layer body), same basis as the type-map S3 pass.

## Live layers declared, by package

| package | layer consts |
|---|---|
${[...byPkg.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `| ${p} | ${n} |`).join("\n")}
| **total** | **${layers.size}** |

Edges: **${edges.length}** — operators: merge ${opCount.merge}, provide ${opCount.provide}, provideMerge ${opCount.provideMerge}; plus ${opCount.requires} \`requires\` (layer-body dependency) edges.

These are **resolved, de-duplicated graph edges** (a source/target that
did not resolve to a catalogued or inline layer node is not edged, and a
repeated source→target pair counts once). They are therefore ≤ the raw
operator **call-site** counts in the *provideMerge vs provide* section
below — that section is the authoritative usage census; this graph is
the structural view.

## Highest fan-in (most layers compose them in)

| layer | fan-in |
|---|---|
${top(fanIn)}

## Highest fan-out (compose in the most layers)

| layer | fan-out |
|---|---|
${top(fanOut)}

## Structural cycles

**${sccs.length}** strongly-connected component(s) with > 1 node or a self-loop.

${sccs.length === 0 ? "_None._ Runtime layer composition is acyclic at the resolved-edge level (the RCWS-RIn shape, if present, is mediated by a `provideMerge` whose source/target did not resolve to two distinct catalogued layer consts — see ts-morph limits)." :
  sccs.map((c, i) => {
    const path = c.map((id) => layers.get(id)?.name ?? id);
    return `### Cycle ${i + 1}\n\n- members: ${c.map((x) => `\`${x}\``).join(", ")}\n- symbol path: ${path.join(" → ")} → ${path[0]}`;
  }).join("\n\n")}

## provideMerge vs provide (counts + named sites)

- \`provide\`: **${provideSites.length}** call sites
- \`provideMerge\`: **${provideMergeSites.length}** call sites

provideMerge sites:

\`\`\`
${provideMergeSites.slice(0, 40).join("\n") || "(none)"}
\`\`\`
${provideMergeSites.length > 40 ? `…and ${provideMergeSites.length - 40} more.\n` : ""}
provide sites (first 40):

\`\`\`
${provideSites.slice(0, 40).join("\n") || "(none)"}
\`\`\`
${provideSites.length > 40 ? `…and ${provideSites.length - 40} more.` : ""}
`;
writeFileSync(join(ROOT, OUT, "layer-composition.md"), md.replace(/[ \t]+$/gm, ""));

console.log(JSON.stringify({
  layers: layers.size, edges: edges.length, ...opCount,
  cycles: sccs.length, unwrapDynamic, hostRoot: hostRoot ?? null,
  closureSize: closure.size, headlineNodes: headline.length,
}, null, 2));
