/**
 * tf-uc8u — test-only / dead production-export gate.
 *
 * THE LEAK knip (lint:dead) cannot see: a PRODUCTION-source export (in
 * `packages/<pkg>/src`, non-test) whose only references are test files — or none at
 * all. knip treats test files as entry points AND treats every symbol
 * re-exported through a public package-subpath barrel as an entry-export, so
 * test-only-used and barrel-shielded-dead production surface both read as
 * "used." Cruft (e.g. the obsolete `ApprovalCall*` schemas) accumulates invisibly.
 *
 * WHY NOT knip (investigated first, per the task):
 *   - The repo exposes ~17 fine-grained public subpaths from `@firegrid/protocol`
 *     (`./agent-tools`, `./channels/router`, …), each a `export *` barrel. So
 *     EVERY protocol src export is an entry-export.
 *   - `includeEntryExports:false` (the default, and required to respect genuine
 *     public API) therefore shields ALL of them → a production-only knip pass
 *     (tests excluded) flags ZERO. `includeEntryExports:true` flags ~387,
 *     including legitimate cross-package public types — over-matching.
 *   - knip's entry-export concept is binary and file-level; it cannot express
 *     "exported-and-public-shaped but imported by no real (non-test) module."
 *   So this is an ADDITIVE, precise scan. It does not weaken or replace knip.
 *
 * PRECISION (the prior ratchet burn was over-matching heuristics):
 *   - Classification uses REAL import resolution (relative + `@firegrid/*`
 *     package-export subpaths + `export *` barrel origin-following), NOT text
 *     grep. (A test local `const Approval = …` must NEVER be confused with the
 *     `ApprovalCall*Schema` exports.)
 *   - Test HELPERS/FIXTURES live in `test/**` — they are never production
 *     exports and are never flagged. The unit flagged is strictly a declaration
 *     in `packages/<pkg>/src` (non-test).
 *
 * OUTPUT classes (FLAG, never auto-delete):
 *   - TEST-ONLY  : ≥1 test importer, 0 production importers — the named leak.
 *   - DEAD       : 0 importers anywhere — barrel-shielded dead surface (e.g.
 *                  `ApprovalCall*`). Reported for review; includes genuinely
 *                  intended-but-unused public API, so it is report-only by
 *                  default.
 *
 * Exit code: 0 by default (report-only, keeps preflight green over the existing
 * backlog). `--strict` exits 1 when any TEST-ONLY export exists (the high-signal,
 * near-zero-false-positive class) — wire that in once the backlog is burned down.
 *
 * Run:  pnpm gate:test-only-exports   [--strict] [--json]
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import * as ts from "typescript"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const rel = (abs: string) => path.relative(ROOT, abs)

const isTestFile = (file: string): boolean =>
  /\.test\.ts$/.test(file) || /(^|\/)test\//.test(rel(file))

// ── file collection ──────────────────────────────────────────────────────────
const collectTs = (dir: string): Array<string> => {
  const out: Array<string> = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectTs(full))
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(full)
  }
  return out
}

const allPackageFiles = (): { prod: Array<string>; test: Array<string> } => {
  const pkgRoot = path.join(ROOT, "packages")
  const prod: Array<string> = []
  const test: Array<string> = []
  for (const pkg of fs.readdirSync(pkgRoot)) {
    const base = path.join(pkgRoot, pkg)
    for (const f of collectTs(path.join(base, "src"))) (isTestFile(f) ? test : prod).push(f)
    for (const f of collectTs(path.join(base, "test"))) test.push(f)
  }
  return { prod: prod.sort(), test: test.sort() }
}

// ── AST helpers ──────────────────────────────────────────────────────────────
const sourceFileOf = (absPath: string): ts.SourceFile =>
  ts.createSourceFile(absPath, fs.readFileSync(absPath, "utf8"), ts.ScriptTarget.Latest, true)
const lineOf = (sf: ts.SourceFile, node: ts.Node): number =>
  sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
const hasExport = (mods: ts.NodeArray<ts.ModifierLike> | undefined): boolean =>
  (mods ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)

interface ExportDecl {
  readonly name: string
  readonly line: number
  readonly kind: string
}
interface ImportRef {
  readonly names: ReadonlyArray<string>
  readonly specifier: string
}
interface ReExportName {
  readonly exported: string // the name importers use
  readonly source: string // the name to look up in the target module (rename-aware)
}
interface ReExport {
  readonly names: ReadonlyArray<ReExportName> | "*"
  readonly specifier: string
}
interface NamespaceImport {
  readonly local: string
  readonly specifier: string
  members: Array<string> | "all" // members actually accessed, or "all" if used opaquely
}
interface FileRec {
  readonly file: string
  readonly exports: Array<ExportDecl> // declared HERE (not re-exported)
  readonly imports: Array<ImportRef>
  readonly reExports: Array<ReExport>
  readonly namespaceImports: Array<NamespaceImport>
  readonly identCount: Map<string, number> // identifier-text occurrences in this file
}

const extractFile = (file: string): FileRec => {
  const sf = sourceFileOf(file)
  const exports: Array<ExportDecl> = []
  const imports: Array<ImportRef> = []
  const reExports: Array<ReExport> = []
  const namespaceImports: Array<NamespaceImport> = []

  sf.forEachChild((node) => {
    // imports
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text
      const names: Array<string> = []
      const ic = node.importClause
      if (ic) {
        if (ic.name) names.push("default")
        if (ic.namedBindings) {
          if (ts.isNamespaceImport(ic.namedBindings)) {
            namespaceImports.push({ local: ic.namedBindings.name.text, specifier: spec, members: [] })
          } // imported name is the ORIGINAL (propertyName), not the local alias:
          // `import { foo as bar }` uses `foo` from the target.
          else for (const el of ic.namedBindings.elements) names.push(el.propertyName?.text ?? el.name.text)
        }
      }
      if (names.length > 0) imports.push({ names, specifier: spec })
      return
    }
    // re-exports (forwarding; NOT a use)
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        // `export { foo as bar } from "x"` — importers see `bar`; the target
        // declares `foo`. Track both so origin-following is rename-aware.
        reExports.push({
          names: node.exportClause.elements.map((e) => ({ exported: e.name.text, source: e.propertyName?.text ?? e.name.text })),
          specifier: spec,
        })
      } else {
        reExports.push({ names: "*", specifier: spec })
      }
      return
    }
    // local export declarations
    if (ts.isVariableStatement(node) && hasExport(node.modifiers)) {
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) exports.push({ name: d.name.text, line: lineOf(sf, d.name), kind: "const" })
      }
    } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name && hasExport(node.modifiers)) {
      exports.push({ name: node.name.text, line: lineOf(sf, node.name), kind: ts.isClassDeclaration(node) ? "class" : "function" })
    } else if ((ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) && hasExport(node.modifiers)) {
      const kind = ts.isInterfaceDeclaration(node) ? "interface" : ts.isEnumDeclaration(node) ? "enum" : "type"
      exports.push({ name: node.name.text, line: lineOf(sf, node.name), kind })
    } else if (ts.isExportDeclaration(node) && !node.moduleSpecifier && node.exportClause && ts.isNamedExports(node.exportClause)) {
      // `export { localName }` — a local symbol; we record it if not a re-export.
      for (const el of node.exportClause.elements) {
        exports.push({ name: el.name.text, line: lineOf(sf, el.name), kind: "export-specifier" })
      }
    }
  })

  // Count every identifier occurrence in the file (for intra-module-use
  // detection). Over-approximate on purpose: counting property-access names
  // etc. only ever makes a symbol look MORE used, biasing the gate toward
  // NOT flagging — the safe direction against false positives.
  const identCount = new Map<string, number>()
  const nsLocals = new Map(namespaceImports.map((n) => [n.local, n]))
  const nsMembers = new Map<string, Set<string>>() // local -> accessed members
  const nsOpaque = new Set<string>() // local used other than as `local.member`
  const countIdents = (n: ts.Node) => {
    if (ts.isIdentifier(n)) {
      identCount.set(n.text, (identCount.get(n.text) ?? 0) + 1)
      if (nsLocals.has(n.text)) {
        const p = n.parent
        const addMember = (m: string) => {
          if (!nsMembers.has(n.text)) nsMembers.set(n.text, new Set())
          nsMembers.get(n.text)!.add(m)
        }
        // `local.member` — value position (PropertyAccess) OR type position
        // (QualifiedName, e.g. `import type * as NS` + `NS.Foo` in a type).
        if (p && ts.isPropertyAccessExpression(p) && p.expression === n) addMember(p.name.text)
        else if (p && ts.isQualifiedName(p) && p.left === n) addMember(p.right.text)
        else if (!(p && (ts.isNamespaceImport(p) || ts.isImportClause(p)))) {
          // used bare (passed as a value, spread, etc.) → cannot scope members
          nsOpaque.add(n.text)
        }
      }
    }
    n.forEachChild(countIdents)
  }
  countIdents(sf)
  for (const ns of namespaceImports) {
    ns.members = nsOpaque.has(ns.local) ? "all" : [...(nsMembers.get(ns.local) ?? [])]
  }
  return { file, exports, imports, reExports, namespaceImports, identCount }
}

// ── package-export resolution (@firegrid/* subpaths → src files) ─────────────
const buildPackageExportMap = (): Map<string, string> => {
  const map = new Map<string, string>()
  const pkgRoot = path.join(ROOT, "packages")
  for (const pkg of fs.readdirSync(pkgRoot)) {
    const pjPath = path.join(pkgRoot, pkg, "package.json")
    if (!fs.existsSync(pjPath)) continue
    const pj = JSON.parse(fs.readFileSync(pjPath, "utf8")) as {
      name?: string
      exports?: Record<string, { default?: string; types?: string } | string>
    }
    if (!pj.name || !pj.exports) continue
    for (const [sub, target] of Object.entries(pj.exports)) {
      const raw = typeof target === "string" ? target : (target.default ?? target.types)
      if (!raw) continue
      const abs = path.resolve(path.join(pkgRoot, pkg), raw)
      const key = sub === "." ? pj.name : `${pj.name}/${sub.replace(/^\.\//, "")}`
      map.set(key, abs)
    }
  }
  return map
}

const resolveCandidate = (p: string): string | null => {
  for (const c of [p, `${p}.ts`, path.join(p, "index.ts")]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
  }
  return null
}
const resolveSpecifier = (importer: string, spec: string, pkgExports: Map<string, string>): string | null => {
  if (spec.startsWith(".")) return resolveCandidate(path.resolve(path.dirname(importer), spec))
  return pkgExports.get(spec) ?? null
}

// ─────────────────────────────────────────────────────────────────────────────
const main = () => {
  const argv = new Set(process.argv.slice(2))
  const strict = argv.has("--strict")
  const asJson = argv.has("--json")

  const { prod, test } = allPackageFiles()
  const pkgExports = buildPackageExportMap()
  const recs = new Map<string, FileRec>()
  for (const f of [...prod, ...test]) recs.set(f, extractFile(f))

  // origin of an exported name (follow `export *` / `export {} from` barrels)
  const originMemo = new Map<string, string | null>()
  const resolveOrigin = (file: string, name: string, depth: number): string | null => {
    const key = `${file}::${name}`
    const cached = originMemo.get(key)
    if (cached !== undefined) return cached
    const rec = recs.get(file)
    if (!rec || depth < 0) return null
    let result: string | null = null
    if (rec.exports.some((e) => e.name === name)) result = file
    else {
      for (const re of rec.reExports) {
        // For a named re-export, match the EXPORTED name and follow with the
        // SOURCE name (rename-aware). For `export *`, pass the name through.
        let sourceName: string | null = null
        if (re.names === "*") sourceName = name
        else {
          const hit = re.names.find((n) => n.exported === name)
          if (hit) sourceName = hit.source
        }
        if (sourceName === null) continue
        const o = resolveSpecifier(file, re.specifier, pkgExports)
        if (o && recs.has(o)) {
          const found = resolveOrigin(o, sourceName, depth - 1)
          if (found) { result = found; break }
        }
      }
    }
    originMemo.set(key, result)
    return result
  }

  // importer tallies per (originFile :: name)
  const prodImporters = new Map<string, Set<string>>()
  const testImporters = new Map<string, Set<string>>()
  const credit = (origin: string, name: string, importer: string, isTest: boolean) => {
    if (origin === importer) return // self-reference is not an importer
    const k = `${origin}::${name}`
    const m = isTest ? testImporters : prodImporters
    if (!m.has(k)) m.set(k, new Set())
    m.get(k)!.add(importer)
  }

  // namespace imports: credit only members ACTUALLY accessed (`P.foo`), unless
  // the namespace is used opaquely (passed as a value) → then credit all.
  const opaqueNamespaceTargets: Array<{ importer: string; isTest: boolean; target: string }> = []

  for (const [file, rec] of recs) {
    const isTest = isTestFile(file)
    for (const imp of rec.imports) {
      const target = resolveSpecifier(file, imp.specifier, pkgExports)
      if (!target || !recs.has(target)) continue
      for (const name of imp.names) {
        const origin = resolveOrigin(target, name, 4)
        if (origin) credit(origin, name, file, isTest)
      }
    }
    for (const ns of rec.namespaceImports) {
      const target = resolveSpecifier(file, ns.specifier, pkgExports)
      if (!target || !recs.has(target)) continue
      if (ns.members === "all") opaqueNamespaceTargets.push({ importer: file, isTest, target })
      else {
        for (const member of ns.members) {
          const origin = resolveOrigin(target, member, 4)
          if (origin) credit(origin, member, file, isTest)
        }
      }
    }
  }
  // opaque namespaces: credit every reachable export from the target barrel
  const reachableExports = (file: string, depth: number, seen: Set<string>): Array<{ origin: string; name: string }> => {
    if (depth < 0 || seen.has(file)) return []
    seen.add(file)
    const rec = recs.get(file)
    if (!rec) return []
    const out = rec.exports.map((e) => ({ origin: file, name: e.name }))
    for (const re of rec.reExports) {
      const o = resolveSpecifier(file, re.specifier, pkgExports)
      if (o && recs.has(o)) {
        const sub = reachableExports(o, depth - 1, seen)
        if (re.names === "*") out.push(...sub)
        else {
          const sources = new Set(re.names.map((n) => n.source))
          out.push(...sub.filter((s) => sources.has(s.name)))
        }
      }
    }
    return out
  }
  for (const ns of opaqueNamespaceTargets) {
    for (const { origin, name } of reachableExports(ns.target, 4, new Set())) {
      credit(origin, name, ns.importer, ns.isTest)
    }
  }

  // classify every production export
  // Only VALUE exports are reliably "dead if unreferenced": a const/function/
  // class/enum cannot be used without importing it. Types/interfaces are used
  // structurally (a function's return type, a variable annotation) with no
  // import of the type name — so "0 import refs" is NOT evidence of deadness.
  // They are reported separately as informational, never gated.
  const VALUE_KINDS = new Set(["const", "function", "class", "enum", "export-specifier"])

  type Klass = "TEST-ONLY" | "TEST-EXPOSED-INTERNAL" | "DEAD"
  interface Finding {
    file: string
    name: string
    line: number
    kind: string
    pkg: string
    isValue: boolean
    intraModuleUse: boolean
    testImporters: number
    klass: Klass
    testRefs: Array<string>
  }
  const findings: Array<Finding> = []
  for (const file of prod) {
    const rec = recs.get(file)!
    const pkg = rel(file).split("/")[1] ?? "?"
    for (const e of rec.exports) {
      const k = `${file}::${e.name}`
      if ((prodImporters.get(k)?.size ?? 0) > 0) continue // a production module imports it → live
      const tImporters = testImporters.get(k)
      const tc = tImporters?.size ?? 0
      // Used elsewhere in its OWN module (occurrences beyond the single
      // declaration identifier)? Then it is live production code, merely also
      // exported — not test-only.
      const intra = (rec.identCount.get(e.name) ?? 0) > 1
      let klass: Klass
      if (tc > 0 && !intra) klass = "TEST-ONLY" // the clean leak: no prod ref at all, kept alive by a test
      else if (tc > 0 && intra) klass = "TEST-EXPOSED-INTERNAL" // live internal code exported only for tests
      else klass = "DEAD" // no consumer anywhere (incl. obsolete self-contained clusters e.g. ApprovalCall*)
      findings.push({
        file: rel(file),
        name: e.name,
        line: e.line,
        kind: e.kind,
        pkg,
        isValue: VALUE_KINDS.has(e.kind),
        intraModuleUse: intra,
        testImporters: tc,
        klass,
        testRefs: tImporters ? [...tImporters].map((t) => rel(t)).sort() : [],
      })
    }
  }
  findings.sort((a, b) =>
    a.klass.localeCompare(b.klass) || a.pkg.localeCompare(b.pkg) || a.file.localeCompare(b.file) || a.line - b.line
  )

  const value = findings.filter((f) => f.isValue)
  const typeFindings = findings.filter((f) => !f.isValue)
  const testOnly = value.filter((f) => f.klass === "TEST-ONLY")
  const testExposed = value.filter((f) => f.klass === "TEST-EXPOSED-INTERNAL")
  const dead = value.filter((f) => f.klass === "DEAD")
  const data = { testOnly, testExposed, dead, typeFindings, prodFiles: prod.length, testFiles: test.length }
  report(data, { strict, asJson })

  // Always persist a committed, deterministic backlog artifact.
  if (!asJson) {
    const outDir = path.join(ROOT, "docs/findings")
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(
      path.join(outDir, "tf-uc8u-test-only-exports.json"),
      JSON.stringify({ tool: "scripts/test-only-export-gate.ts", bead: "tf-uc8u", note: "Machine-generated. FLAG only; review per item.", ...data }, null, 2) + "\n",
    )
    fs.writeFileSync(path.join(outDir, "tf-uc8u-test-only-exports.md"), renderArtifact(data) + "\n")
  }

  // Gate only on the high-precision class: VALUE exports referenced solely by
  // tests. (DEAD value exports include intended-but-unused public API, so they
  // are reported, not gated.)
  if (strict && testOnly.length > 0) process.exit(1)
}

interface ReportFinding {
  file: string
  name: string
  line: number
  kind: string
  pkg: string
  klass?: string
  testRefs?: Array<string>
}

const renderArtifact = (data: {
  testOnly: Array<ReportFinding>
  testExposed: Array<ReportFinding>
  dead: Array<ReportFinding>
  typeFindings: Array<ReportFinding>
  prodFiles: number
  testFiles: number
}): string => {
  const L: Array<string> = []
  const tbl = (items: Array<ReportFinding>, withTests: boolean) => {
    L.push(`| export | kind | ref |${withTests ? " test importers |" : ""}`)
    L.push(`| --- | --- | --- |${withTests ? " --- |" : ""}`)
    for (const f of items) {
      L.push(`| \`${f.name}\` | ${f.kind} | ${f.file}:${f.line} |${withTests ? ` ${(f.testRefs ?? []).map((t) => `\`${t}\``).join("<br>")} |` : ""}`)
    }
  }
  L.push("# tf-uc8u — test-only / dead production-export backlog")
  L.push("")
  L.push("> **Machine-generated by `scripts/test-only-export-gate.ts` (`pnpm gate:test-only-exports`). Do not edit by hand.**")
  L.push("> FLAG only — nothing is auto-deleted. Each class needs human triage (see the findings note).")
  L.push("")
  L.push(`Scanned ${data.prodFiles} production + ${data.testFiles} test files. Real import resolution (relative + \`@firegrid/*\` subpaths + rename-aware barrel following + member-precise namespace access).`)
  L.push("")
  L.push(`## 1. TEST-ONLY value exports — ${data.testOnly.length}  (the named leak; \`--strict\` gates on this)`)
  L.push("")
  L.push("Zero production reference anywhere (not even intra-module); a production export kept alive solely by a test. Includes both obsolete cruft and barrel-exported public API exercised only by tests — triage each.")
  L.push("")
  tbl(data.testOnly, true)
  L.push("")
  L.push(`## 2. TEST-EXPOSED-INTERNAL value exports — ${data.testExposed.length}  (report)`)
  L.push("")
  L.push("Used by live code within their own module, but imported by no other production module — only by tests. The `export` exists for the test (a test reaching into internals); the code itself is live.")
  L.push("")
  tbl(data.testExposed, true)
  L.push("")
  L.push(`## 3. DEAD value exports — ${data.dead.length}  (report)`)
  L.push("")
  L.push("No production consumer and no test consumer (only intra-module self-references, if any). The obsolete-cruft case — e.g. `ApprovalCall*` — lives here, alongside intended-but-unused public API of leaf SDK/library packages. Review per item.")
  L.push("")
  tbl(data.dead, false)
  L.push("")
  L.push(`## 4. INFORMATIONAL: type/interface exports with no import refs — ${data.typeFindings.length}  (NOT gated)`)
  L.push("")
  L.push("Types are used structurally without importing the name, so a 0-import count is **not** evidence of deadness. Listed in the JSON artifact for context; not a finding.")
  L.push("")
  return L.join("\n")
}
const report = (
  data: {
    testOnly: Array<ReportFinding>
    testExposed: Array<ReportFinding>
    dead: Array<ReportFinding>
    typeFindings: Array<ReportFinding>
    prodFiles: number
    testFiles: number
  },
  opts: { strict: boolean; asJson: boolean },
) => {
  if (opts.asJson) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(data, null, 2))
    return
  }
  const log = (s = "") => process.stdout.write(s + "\n")
  const byPkgList = (items: Array<ReportFinding>) => {
    const byPkg = new Map<string, Array<ReportFinding>>()
    for (const f of items) {
      if (!byPkg.has(f.pkg)) byPkg.set(f.pkg, [])
      byPkg.get(f.pkg)!.push(f)
    }
    for (const [pkg, list] of [...byPkg].sort((a, b) => b[1].length - a[1].length)) {
      log(`  ${pkg} (${list.length}):`)
      for (const f of list) log(`    ${f.file}:${f.line}  ${f.name} [${f.kind}]`)
    }
  }

  log(`tf-uc8u test-only / dead production-export gate  (${opts.strict ? "strict" : "report-only"})`)
  log(`scanned ${data.prodFiles} production + ${data.testFiles} test files`)
  log("")
  log(`══ TEST-ONLY value exports — ${data.testOnly.length}   [GATED]`)
  log("   No production reference ANYWHERE (not even intra-module); kept alive solely by a test.")
  log("   The clean leak — a production export that exists only because a test imports it.")
  if (data.testOnly.length === 0) log("  (none)")
  for (const f of data.testOnly) {
    log(`  ${f.file}:${f.line}  ${f.name} [${f.kind}]  ← ${(f.testRefs ?? []).join(", ")}`)
  }
  log("")
  log(`══ TEST-EXPOSED-INTERNAL value exports — ${data.testExposed.length}   [report]`)
  log("   Used by live code WITHIN their own module, but imported by no other production module —")
  log("   only by tests. The `export` exists for the test (test reaching into internals); the code is live.")
  if (data.testExposed.length === 0) log("  (none)")
  byPkgList(data.testExposed)
  log("")
  log(`══ DEAD value exports — ${data.dead.length}   [report]`)
  log("   No production consumer and no test consumer (only intra-module self-references, if any).")
  log("   Obsolete self-contained clusters (e.g. ApprovalCall*) live here — AND intended-but-unused")
  log("   public API of leaf SDK/library packages. Review per item; do not bulk-delete.")
  if (data.dead.length === 0) log("  (none)")
  byPkgList(data.dead)
  log("")
  log(`══ INFORMATIONAL: type/interface exports with no import refs — ${data.typeFindings.length}   [not gated]`)
  log("   Types are used structurally without importing the name, so 0-refs is NOT evidence of deadness.")
  log("")
  log("FLAG only — nothing is auto-deleted. Gate (--strict) fires on TEST-ONLY only (the high-precision class).")
}

main()
