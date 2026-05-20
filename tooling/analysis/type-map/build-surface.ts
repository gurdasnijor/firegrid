// Analysis B — public surface + type liveness. Mechanical, not a plan.
//
// Re-collects declarations with the SAME id scheme as build-type-map.ts
// (pkg::name) so catalog.json ids line up, then attaches three columns:
//   is_public_export   — reachable from the package entry point(s)
//                         (package.json exports/main), re-exports resolved
//                         by ts-morph getExportedDeclarations (handles
//                         `export *`; unresolved chains are flagged).
//   is_value_referenced — a non-type reference exists (new X, X(), X.y,
//                         yield* X, = X) via symbol resolution.
//   is_test_referenced  — referenced from *.test/*.spec/**/test/** files.
// Classifies every type: PUBLIC / CROSS-PACKAGE / INTERNAL / TEST-ONLY /
// DEAD. No interpretation, no remediation.
import { Project, Node, ts } from "ts-morph";
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const OUT = "tooling/analysis/type-map";

// ── project (incl. tests this time, so test refs are visible) ───────
const paths: Record<string, string[]> = {};
const entryFiles: string[] = [];
for (const root of ["packages"] as const) {
  if (!existsSync(join(ROOT, root))) continue;
  for (const d of readdirSync(join(ROOT, root))) {
    const pj = join(ROOT, root, d, "package.json");
    if (!existsSync(pj)) continue;
    const p = JSON.parse(readFileSync(pj, "utf8"));
    if (!p.name) continue;
    const ex = p.exports ?? {};
    const targets = new Set<string>();
    for (const k of Object.keys(ex)) {
      const v = ex[k];
      const t = typeof v === "string" ? v : v?.types ?? v?.default;
      if (!t) continue;
      const rel = join(root, d, t.replace(/^\.\//, ""));
      const spec = k === "." ? p.name : `${p.name}/${k.replace(/^\.\//, "")}`;
      paths[spec] = [rel];
      targets.add(rel);
    }
    if (typeof p.main === "string" && p.main.endsWith(".ts"))
      targets.add(join(root, d, p.main.replace(/^\.\//, "")));
    for (const t of targets) if (existsSync(join(ROOT, t))) entryFiles.push(t);
  }
}
const pkgOf = (fp: string): string => {
  const m = relative(ROOT, fp).match(/^packages\/([^/]+)\//);
  return m ? `packages/${m[1]}` : "?";
};
const isTestFile = (fp: string) =>
  /\.(test|spec)\.tsx?$/.test(fp) || /\/(test|__tests__)\//.test(fp);

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
  "!**/*.d.ts", "!**/*.gen.ts", "!**/generated/**",
]);

// ── 1. re-collect declarations (mirror of build-type-map.ts) ────────
type Kind =
  | "type-alias" | "interface" | "context-tag" | "schema-tagged-class"
  | "schema-struct" | "schema-union" | "workflow" | "layer-instance" | "other";
type Rec = {
  id: string; name: string; kind: Kind; pkg: string; file: string;
  startLine: number; endLine: number;
  is_public_export: boolean; is_value_referenced: boolean; is_test_referenced: boolean;
  classification: "PUBLIC" | "CROSS-PACKAGE" | "INTERNAL" | "TEST-ONLY" | "DEAD";
};
const recs: Rec[] = [];
const nameNodeOf = new Map<string, Node>();      // id → name identifier node
const TAGEXT = /\b(Context\.(Tag|Reference|GenericTag)|Effect\.(Tag|Service))\b/;
const SCHEMACLASS = /\bSchema\.(TaggedClass|TaggedError|TaggedRequest|Class)\b/;

const add = (name: string, kind: Kind, decl: Node, nameNode: Node, sf: string) => {
  const pkg = pkgOf(sf);
  const id = `${pkg}::${name}`;
  if (nameNodeOf.has(id)) return;
  recs.push({
    id, name, kind, pkg, file: relative(ROOT, sf),
    startLine: decl.getStartLineNumber(), endLine: decl.getEndLineNumber(),
    is_public_export: false, is_value_referenced: false,
    is_test_referenced: false, classification: "DEAD",
  });
  nameNodeOf.set(id, nameNode);
};

for (const sf of project.getSourceFiles()) {
  const fp = sf.getFilePath();
  if (!/\/packages\/[^/]+\/src\//.test(fp) || isTestFile(fp)) continue;
  for (const i of sf.getInterfaces()) add(i.getName(), "interface", i, i.getNameNode(), fp);
  for (const t of sf.getTypeAliases()) {
    const rhs = t.getTypeNode()?.getText() ?? "";
    add(t.getName(), /\bSchema\.Union\b|\|/.test(rhs) && /Schema\./.test(rhs) ? "schema-union" : "type-alias", t, t.getNameNode(), fp);
  }
  for (const c of sf.getClasses()) {
    const name = c.getName(); const nn = c.getNameNode();
    if (!name || !nn) continue;
    const ext = c.getExtends()?.getText() ?? "";
    add(name, TAGEXT.test(ext) ? "context-tag" : SCHEMACLASS.test(ext) ? "schema-tagged-class" : "other", c, nn, fp);
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
    if (kind) {
      const nn = v.getNameNode();
      if (Node.isIdentifier(nn)) add(v.getName(), kind, v, nn, fp);
    }
  }
  for (const e of sf.getEnums()) add(e.getName(), "other", e, e.getNameNode(), fp);
}

// ── 2. is_public_export via entry getExportedDeclarations ───────────
const publicKey = new Set<string>();             // `${file}:${startLine}:${name}`
let exportResolveGaps = 0;
for (const ef of [...new Set(entryFiles)]) {
  const sf = project.getSourceFile(join(ROOT, ef)) ?? project.addSourceFileAtPathIfExists(join(ROOT, ef));
  if (!sf) { exportResolveGaps++; continue; }
  try {
    for (const [name, decls] of sf.getExportedDeclarations())
      for (const d of decls)
        publicKey.add(`${relative(ROOT, d.getSourceFile().getFilePath())}:${d.getStartLineNumber()}:${name}`);
  } catch { exportResolveGaps++; }
}

// ── 3. references (symbol resolution): value? cross-pkg? test? ───────
const valuePositions = (ref: Node): boolean => {
  // a reference is a value use if it is NOT inside a type-only position.
  const p = ref.getParent();
  if (!p) return false;
  if (Node.isTypeReference(p) || Node.isTypeQuery(p)) return false;
  if (Node.isImportSpecifier(p) || Node.isExportSpecifier(p) ||
    Node.isImportClause(p) || Node.isNamespaceImport(p)) return false;
  if (Node.isExpressionWithTypeArguments(p)) {     // heritage: implements/extends type
    const h = p.getParentIfKind(ts.SyntaxKind.HeritageClause);
    if (h && h.getToken() === ts.SyntaxKind.ImplementsKeyword) return false;
  }
  // value positions: call/new callee, prop-access object, yield arg,
  // initializer/argument, shorthand — anything in an expression slot.
  // argument of a call/new: ref's parent is the Call/New and ref is in its args
  if ((Node.isCallExpression(p) || Node.isNewExpression(p)) &&
    p.getArguments().includes(ref)) return true;
  return Node.isCallExpression(p) || Node.isNewExpression(p) ||
    Node.isPropertyAccessExpression(p) || Node.isYieldExpression(p) ||
    Node.isElementAccessExpression(p) || Node.isBinaryExpression(p) ||
    Node.isVariableDeclaration(p) ||
    Node.isArrowFunction(p) || Node.isReturnStatement(p) ||
    Node.isSpreadElement(p) || Node.isPropertyAssignment(p) ||
    Node.isShorthandPropertyAssignment(p) || Node.isAsExpression(p) ||
    Node.isAwaitExpression(p);
};

let refErrors = 0;
for (const r of recs) {
  const nn = nameNodeOf.get(r.id)!;
  if (!Node.isIdentifier(nn)) continue;
  let refs: Node[] = [];
  try { refs = nn.findReferencesAsNodes(); }
  catch { refErrors++; continue; }
  for (const ref of refs) {
    if (ref === nn) continue;
    // import/export specifiers & re-export clauses are PLUMBING, not a
    // use — counting a type's own `export { X }` as a same-package ref
    // would make nothing ever DEAD/TEST-ONLY. Skip for classification.
    const par = ref.getParent();
    if (par && (Node.isImportSpecifier(par) || Node.isExportSpecifier(par) ||
      Node.isImportClause(par) || Node.isNamespaceImport(par) ||
      Node.isNamespaceExport(par) || Node.isExportAssignment(par))) continue;
    const fp = ref.getSourceFile().getFilePath();
    if (isTestFile(fp)) { r.is_test_referenced = true; continue; }
    const samePkg = pkgOf(fp) === r.pkg;
    if (!samePkg) r.classification = "CROSS-PACKAGE";   // provisional; PUBLIC overrides below
    else if (r.classification === "DEAD") r.classification = "INTERNAL";
    if (valuePositions(ref)) r.is_value_referenced = true;
  }
}

// ── 4. finalize classification ──────────────────────────────────────
for (const r of recs) {
  r.is_public_export = publicKey.has(`${r.file}:${r.startLine}:${r.name}`);
  const anyNonTest = r.classification === "INTERNAL" || r.classification === "CROSS-PACKAGE";
  if (r.is_public_export) r.classification = "PUBLIC";
  else if (!anyNonTest && r.is_test_referenced) r.classification = "TEST-ONLY";
  else if (!anyNonTest && !r.is_test_referenced) r.classification = "DEAD";
  // else keep INTERNAL / CROSS-PACKAGE
}

// ── 5. augment catalog.json (if present) + write surface.md ─────────
const catPath = join(ROOT, OUT, "catalog.json");
if (existsSync(catPath)) {
  const cat = JSON.parse(readFileSync(catPath, "utf8"));
  const col = new Map(recs.map((r) => [r.id, r]));
  for (const rec of cat.records ?? []) {
    const m = col.get(rec.id);
    if (m) Object.assign(rec, {
      is_public_export: m.is_public_export,
      is_value_referenced: m.is_value_referenced,
      is_test_referenced: m.is_test_referenced,
      classification: m.classification,
    });
  }
  cat.surfaceColumns = {
    added: "is_public_export, is_value_referenced, is_test_referenced, classification",
    generated: new Date().toISOString(),
  };
  writeFileSync(catPath, JSON.stringify(cat, null, 2));
}

const CLASSES = ["PUBLIC", "CROSS-PACKAGE", "INTERNAL", "TEST-ONLY", "DEAD"] as const;
const pkgs = [...new Set(recs.map((r) => r.pkg))].sort();
const tbl = pkgs.map((p) => {
  const rs = recs.filter((r) => r.pkg === p);
  const c = (k: string) => rs.filter((r) => r.classification === k).length;
  return `| ${p} | ${rs.length} | ${c("PUBLIC")} | ${c("INTERNAL")} | ${c("CROSS-PACKAGE")} | ${c("TEST-ONLY")} | ${c("DEAD")} |`;
}).join("\n");
const total = (k: string) => recs.filter((r) => r.classification === k).length;
const sample = (k: string, pkg?: string) =>
  recs.filter((r) => r.classification === k && (!pkg || r.pkg === pkg))
    .slice(0, 30).map((r) => `- \`${r.id}\` (${r.kind})`).join("\n") || "(none)";

const md = `# Analysis B — Public Surface & Type Liveness

Generated ${new Date().toISOString()}. Mechanical. ${recs.length} declared
types, three liveness columns added to \`catalog.json\`. No remediation.

## Method & honesty

- \`is_public_export\`: reachable from a package entry point
  (\`package.json\` \`exports\`/\`main\`), re-exports resolved by ts-morph
  \`getExportedDeclarations()\` (resolves \`export *\`). Entry files not
  found / resolution gaps: **${exportResolveGaps}**. NOTE: a package
  whose entry does \`export * from "./…"\` makes everything transitively
  reachable PUBLIC by this definition — PUBLIC = *entry-reachable*, not
  *curated API*. Read the per-package table with that in mind.
- \`is_value_referenced\`: a reference in a value/expression position
  (heuristic — type-reference, type-query, import/export specifier and
  \`implements\` heritage are treated as type-only; everything else in an
  expression slot is value). Imperfect for ambiguous slots; stated.
- \`is_test_referenced\`: a reference from \`*.test\`/\`*.spec\`/\`**/test/**\`.
- **Plumbing excluded.** Import/export specifiers, re-export clauses and
  namespace im/exports are not counted as references — a type's own
  \`export { X }\` is not a "use". Without this, nothing is ever DEAD or
  TEST-ONLY (every exported type re-references itself through plumbing).
- Reference resolution via ts-morph \`findReferencesAsNodes\`; failures:
  **${refErrors}** (counted, excluded — not silently dropped).
- Classification precedence: PUBLIC (entry-reachable) ▸ CROSS-PACKAGE
  (non-test referrer in another package, not public) ▸ INTERNAL
  (non-test referrer only in declaring package) ▸ TEST-ONLY ▸ DEAD
  (zero references anywhere). \`is_value_referenced\` is reported as a
  column but is orthogonal to the class (a type can be public yet only
  type-referenced).

## Totals by classification

| class | count | meaning |
|---|---|---|
| PUBLIC | ${total("PUBLIC")} | reachable from a package entry point |
| CROSS-PACKAGE | ${total("CROSS-PACKAGE")} | consumed by another package but **not** via its public entry |
| INTERNAL | ${total("INTERNAL")} | referenced only within its declaring package (non-test) |
| TEST-ONLY | ${total("TEST-ONLY")} | referenced only from test files |
| DEAD | ${total("DEAD")} | zero references anywhere |
| **total** | **${recs.length}** | |

value-referenced (any class): ${recs.filter((r) => r.is_value_referenced).length} ·
test-referenced: ${recs.filter((r) => r.is_test_referenced).length}

## Per-package surface

| package | total | PUBLIC | INTERNAL | CROSS-PKG | TEST-ONLY | DEAD |
|---|---|---|---|---|---|---|
${tbl}

## CROSS-PACKAGE — consumed past a package's public entry (first 30)

${sample("CROSS-PACKAGE")}
${total("CROSS-PACKAGE") > 30 ? `\n…and ${total("CROSS-PACKAGE") - 30} more (see catalog.json \`classification\`).` : ""}

## DEAD — zero resolved references (first 30)

${sample("DEAD")}
${total("DEAD") > 30 ? `\n…and ${total("DEAD") - 30} more.` : ""}

## TEST-ONLY (first 30)

${sample("TEST-ONLY")}
${total("TEST-ONLY") > 30 ? `\n…and ${total("TEST-ONLY") - 30} more.` : ""}
`;
writeFileSync(join(ROOT, OUT, "surface.md"), md.replace(/[ \t]+$/gm, ""));

console.log(JSON.stringify({
  declared: recs.length,
  PUBLIC: total("PUBLIC"), CROSS: total("CROSS-PACKAGE"),
  INTERNAL: total("INTERNAL"), TEST_ONLY: total("TEST-ONLY"), DEAD: total("DEAD"),
  valueRef: recs.filter((r) => r.is_value_referenced).length,
  exportResolveGaps, refErrors,
}, null, 2));
