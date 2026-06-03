/**
 * tf-o7id — package export-surface audit.
 *
 * For every workspace package, enumerate its `package.json#exports` subpaths and
 * count how many OTHER packages actually import each subpath specifier. A subpath
 * with zero external importers is pure oversharing: a public entry that widens the
 * package's API (and the dead-code blind spot — every symbol reachable through it
 * reads as an "entry export") for no consumer.
 *
 * "External" = an import/export-from specifier in a file OUTSIDE the owning
 * package directory. A package consuming its own subpath via the bare specifier
 * (rare; internal code uses relative paths) does NOT justify a public export, so
 * self-imports are not counted. Test files in OTHER packages DO count.
 *
 * Specifier matching is exact + quote-bounded (`"@firegrid/runtime/channels"`),
 * so `/channels` is never credited by `/channels/router/live`. Covers both
 * `import ... from "spec"` and `export ... from "spec"` (re-export barrels are
 * real consumers) and bare `import "spec"` side-effect imports.
 *
 * Deterministic, zero-new-dep, re-runnable. Writes a committed artifact.
 *
 * Run:  pnpm tsx scripts/package-exports-audit.ts [--json]
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const rel = (abs: string) => path.relative(ROOT, abs)

const collectTs = (dir: string): Array<string> => {
  const out: Array<string> = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      // skip deps, build output, vendored upstreams, and VCS
      if (["node_modules", "dist", "repos", ".git"].includes(entry.name)) continue
      out.push(...collectTs(full))
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(full)
  }
  return out
}

interface SubpathRec {
  readonly pkg: string
  readonly subpath: string // "." or "./channels"
  readonly specifier: string // "@firegrid/runtime" or "@firegrid/runtime/channels"
  readonly target: string // resolved src file (rel)
  importers: Array<string> // external importer files (rel), sorted
}

// every `from "spec"` / bare `import "spec"` specifier occurrence, per file
const specifiersIn = (src: string): Array<string> => {
  const out: Array<string> = []
  // import ... from "x" | export ... from "x" | import "x" | import("x")
  const re = /(?:from\s*|import\s*\(?\s*)["']([^"']+)["']/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) out.push(m[1])
  return out
}

const main = () => {
  const asJson = process.argv.includes("--json")
  const pkgRoot = path.join(ROOT, "packages")
  const pkgDirs = fs.readdirSync(pkgRoot).filter((d) => fs.existsSync(path.join(pkgRoot, d, "package.json")))

  // package name -> directory (for owner exclusion)
  const nameToDir = new Map<string, string>()
  const subpaths: Array<SubpathRec> = []
  for (const d of pkgDirs) {
    const pjPath = path.join(pkgRoot, d, "package.json")
    const pj = JSON.parse(fs.readFileSync(pjPath, "utf8")) as {
      name?: string
      exports?: Record<string, { default?: string; types?: string } | string>
    }
    if (!pj.name) continue
    nameToDir.set(pj.name, path.join(pkgRoot, d))
    if (!pj.exports) continue
    for (const [sub, target] of Object.entries(pj.exports)) {
      const raw = typeof target === "string" ? target : (target.default ?? target.types)
      const specifier = sub === "." ? pj.name : `${pj.name}/${sub.replace(/^\.\//, "")}`
      const absTarget = raw ? path.resolve(path.join(pkgRoot, d), raw) : ""
      subpaths.push({ pkg: pj.name, subpath: sub, specifier, target: raw ? rel(absTarget) : "(none)", importers: [] })
    }
  }

  // index: specifier -> rec (for O(1) credit). Multiple subpaths can share a spec? no, keys unique per pkg.
  const bySpec = new Map<string, SubpathRec>()
  for (const r of subpaths) bySpec.set(r.specifier, r)

  // scan every ts file; credit the exact specifier to its rec if the importer
  // is OUTSIDE the owning package directory.
  const dirOf = (rec: SubpathRec) => nameToDir.get(rec.pkg)!
  // scan the WHOLE repo (not just packages/) so importers in tools/tooling/
  // features/scripts/apps are counted — under-counting would wrongly seal a
  // used subpath.
  for (const file of collectTs(ROOT)) {
    const src = fs.readFileSync(file, "utf8")
    for (const spec of specifiersIn(src)) {
      const rec = bySpec.get(spec)
      if (!rec) continue
      const ownerDir = dirOf(rec)
      if (file.startsWith(ownerDir + path.sep)) continue // self-import; not external
      if (!rec.importers.includes(file)) rec.importers.push(file)
    }
  }
  for (const r of subpaths) r.importers = r.importers.map(rel).sort()

  // group by package
  const byPkg = new Map<string, Array<SubpathRec>>()
  for (const r of subpaths) {
    if (!byPkg.has(r.pkg)) byPkg.set(r.pkg, [])
    byPkg.get(r.pkg)!.push(r)
  }

  const summary = [...byPkg.entries()]
    .map(([pkg, list]) => ({
      pkg,
      total: list.length,
      used: list.filter((r) => r.importers.length > 0).length,
      unused: list.filter((r) => r.importers.length === 0).length,
    }))
    .sort((a, b) => b.unused - a.unused || b.total - a.total)

  const data = { summary, subpaths: subpaths.sort((a, b) => a.pkg.localeCompare(b.pkg) || a.subpath.localeCompare(b.subpath)) }

  if (asJson) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(data, null, 2))
    return
  }

  const log = (s = "") => process.stdout.write(s + "\n")
  log("package export-surface audit  (unused = 0 external importers → oversharing)")
  log("")
  log("pkg".padEnd(28) + "total  used  unused")
  for (const s of summary) {
    log(s.pkg.padEnd(28) + String(s.total).padStart(5) + String(s.used).padStart(6) + String(s.unused).padStart(8))
  }
  log("")
  for (const [pkg, list] of byPkg) {
    const unused = list.filter((r) => r.importers.length === 0)
    if (unused.length === 0) continue
    log(`── ${pkg} — ${unused.length} unused subpath(s):`)
    for (const r of unused) log(`    ${r.subpath.padEnd(46)} → ${r.target}`)
  }

  // committed artifact
  const outDir = path.join(ROOT, "docs/findings")
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(
    path.join(outDir, "tf-o7id-export-surface-audit.json"),
    JSON.stringify({ tool: "scripts/package-exports-audit.ts", bead: "tf-o7id", note: "Machine-generated. UNUSED = 0 external importers.", ...data }, null, 2) + "\n",
  )
  const L: Array<string> = []
  L.push("# tf-o7id — package export-surface audit")
  L.push("")
  L.push("> Machine-generated by `scripts/package-exports-audit.ts` (`pnpm tsx scripts/package-exports-audit.ts`). Do not edit by hand.")
  L.push("> UNUSED = a `package.json#exports` subpath imported by zero files outside its owning package. Pure public-surface oversharing.")
  L.push("")
  L.push("| package | total subpaths | used | unused |")
  L.push("| --- | --- | --- | --- |")
  for (const s of summary) L.push(`| \`${s.pkg}\` | ${s.total} | ${s.used} | ${s.unused} |`)
  L.push("")
  for (const [pkg, list] of byPkg) {
    const unused = list.filter((r) => r.importers.length === 0)
    if (unused.length === 0) continue
    L.push(`## \`${pkg}\` — ${unused.length} unused subpath(s)`)
    L.push("")
    L.push("| subpath | target |")
    L.push("| --- | --- |")
    for (const r of unused) L.push(`| \`${r.subpath}\` | ${r.target} |`)
    L.push("")
  }
  fs.writeFileSync(path.join(outDir, "tf-o7id-export-surface-audit.md"), L.join("\n") + "\n")
}

main()
