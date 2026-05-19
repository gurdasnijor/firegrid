// S3 — service-dependency graph (ts-morph). Map, not plan. Tags → their
// Live layer(s) → tags yielded inside that layer's build body. Cycle
// presence is the precommitment: none → composition reorder suffices;
// cycles → architectural intervention (the PR #363 cascade signature).
import { Project, Node, SyntaxKind } from "ts-morph";

const proj = new Project({
  tsConfigFilePath: "packages/host-sdk/tsconfig.json",
  skipAddingFilesFromTsConfig: false,
});
const inScope = (p: string) =>
  /\/packages\/(host-sdk|runtime)\/src\//.test(p);

// 1. tag declarations: `class X extends Context.Tag/Reference/Effect.Service(..)`
//    and `const X = Context.GenericTag(..)`.
type TagInfo = { name: string; pkg: string; file: string; hasLive: boolean };
const tags = new Map<string, TagInfo>();
const pkgOf = (fp: string) =>
  (fp.match(/\/packages\/([^/]+)\//) ?? [, "?"])[1] as string;

for (const sf of proj.getSourceFiles()) {
  const fp = sf.getFilePath();
  if (!inScope(fp)) continue;
  // word-boundary, NOT `\(` — the generic forms `Effect.Service<F>()(…)`
  // and `Context.Tag("F")<F,…>()` have `<…>` before the call paren.
  const TAGEXT = /\b(Context\.(Tag|Reference|GenericTag)|Effect\.(Tag|Service))\b/;
  for (const c of sf.getClasses()) {
    const ext = c.getExtends()?.getText() ?? "";
    if (TAGEXT.test(ext) && c.getName())
      tags.set(c.getName()!, { name: c.getName()!, pkg: pkgOf(fp), file: fp, hasLive: false });
  }
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer()?.getText() ?? "";
    if (TAGEXT.test(init))
      tags.set(v.getName(), { name: v.getName(), pkg: pkgOf(fp), file: fp, hasLive: false });
  }
}

// 2. provider edges: Layer.{effect,scoped,succeed,sync,effectDiscard}(TAG, body)
//    → TAG depends on every known tag `yield*`-ed (or Layer.provide'd) in body.
const edges = new Set<string>();        // "A->B"  (A depends on B)
const multiLive = new Map<string, number>();

for (const sf of proj.getSourceFiles()) {
  if (!inScope(sf.getFilePath())) continue;
  sf.forEachDescendant((n) => {
    if (!Node.isCallExpression(n)) return;
    const callee = n.getExpression().getText();
    if (!/^Layer\.(effect|scoped|succeed|sync|effectDiscard)$/.test(callee)) return;
    const args = n.getArguments();
    const provided = args[0]?.getText().replace(/<.*/, "").trim();
    if (!provided || !tags.has(provided)) return;
    tags.get(provided)!.hasLive = true;
    multiLive.set(provided, (multiLive.get(provided) ?? 0) + 1);
    const body = args[1];
    if (!body) return;
    const bodyText = body.getText();
    for (const dep of tags.keys()) {
      if (dep === provided) continue;
      // yield* Dep | Dep.pipe | Layer.provide(Dep) | Effect.provideService(_, Dep
      const re = new RegExp(`yield\\*\\s+${dep}\\b|\\b${dep}\\.pipe|provide\\w*\\([^)]*\\b${dep}\\b`);
      if (re.test(bodyText)) edges.add(`${provided}->${dep}`);
    }
  });
}

// 3. cycle detection (Tarjan SCC over the edge set).
const adj = new Map<string, string[]>();
for (const e of edges) {
  const [a, b] = e.split("->");
  (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
}
let idx = 0;
const I = new Map<string, number>(), L = new Map<string, number>();
const onstk = new Set<string>(), stk: string[] = [], sccs: string[][] = [];
const strong = (v: string) => {
  I.set(v, idx); L.set(v, idx); idx++; stk.push(v); onstk.add(v);
  for (const w of adj.get(v) ?? []) {
    if (!I.has(w)) { strong(w); L.set(v, Math.min(L.get(v)!, L.get(w)!)); }
    else if (onstk.has(w)) L.set(v, Math.min(L.get(v)!, I.get(w)!));
  }
  if (L.get(v) === I.get(v)) {
    const comp: string[] = []; let w: string;
    do { w = stk.pop()!; onstk.delete(w); comp.push(w); } while (w !== v);
    if (comp.length > 1 || (adj.get(v) ?? []).includes(v)) sccs.push(comp);
  }
};
for (const v of adj.keys()) if (!I.has(v)) strong(v);

const tagsNoLive = [...tags.values()].filter((t) => !t.hasLive).map((t) => t.name);
const multi = [...multiLive.entries()].filter(([, c]) => c > 1).map(([n, c]) => `${n} (${c})`);

// DOT (host-sdk/runtime scope is small enough to render)
const dot = [
  "digraph services {",
  '  rankdir=LR; node [shape=box,fontsize=10];',
  ...[...edges].map((e) => { const [a, b] = e.split("->"); return `  "${a}" -> "${b}";`; }),
  ...sccs.flatMap((c) => c).map((n) => `  "${n}" [color=red,penwidth=2];`),
  "}",
].join("\n");

console.log(JSON.stringify({
  analysis: "S3", generated: new Date().toISOString(),
  tagCount: tags.size, edgeCount: edges.size,
  cycles: sccs, cycleCount: sccs.length,
  multiLive: multi, tagsWithoutLive: tagsNoLive,
  crossPkg: [...edges].map((e) => e.split("->"))
    .filter(([a, b]) => tags.get(a) && tags.get(b) && tags.get(a)!.pkg !== tags.get(b)!.pkg)
    .map(([a, b]) => `${a}(${tags.get(a)!.pkg}) -> ${b}(${tags.get(b)!.pkg})`),
}, null, 2));
process.stderr.write(dot + "\n");
