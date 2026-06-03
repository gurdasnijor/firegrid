/**
 * tf-bcg1 — canonical contract.id gate.
 *
 * THE GAP this closes: the "HISTORICAL banner + cannon allowlist" convention was
 * advisory only — nothing failed CI when production code (or a doc) pointed at a
 * historical / non-canonical SDD as if it were the live contract. An operator
 * linked 8 pre-#765 historical SDDs as canonical and only PO pushback caught it.
 * Convention is not enforcement; this gate is the enforcement.
 *
 * RULE: every `"firegrid.contract.id": "<path>"` span attribute in production
 * source MUST point at a doc that is (a) reachable, (b) NOT under
 * `docs/sdds/_archive/`, and (c) listed as canonical in `docs/cannon/README.md`
 * (the dispatch allowlist — everything under the "Explicitly Non-Canonical Or
 * Historical" section, and everything not listed at all, is non-canonical).
 *
 * The allowlist is parsed from the README itself, so the source of truth stays
 * the one curated index — add a doc there to make it a legal contract target.
 *
 * Deterministic, zero-new-dep. Run:  pnpm tsx scripts/contract-id-canonical-gate.ts
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CANNON_DIR = path.join(ROOT, "docs/cannon")
const README = path.join(CANNON_DIR, "README.md")
const NON_CANONICAL_HEADER = "## Explicitly Non-Canonical Or Historical"

// ── allowlist: canonical doc paths declared in docs/cannon/README.md ──────────
const buildAllowlist = (): Set<string> => {
  const text = fs.readFileSync(README, "utf8")
  // Drop the "Explicitly Non-Canonical Or Historical" section (and anything
  // after it that isn't a fresh canonical section) so its docs are NOT allowed.
  const cut = text.indexOf(NON_CANONICAL_HEADER)
  const canonicalText = cut >= 0 ? text.slice(0, cut) : text
  const allow = new Set<string>()
  // markdown links `[..](path.md)` and inline-code paths `` `path.md` ``
  const re = /(?:\]\(|`)([^()`\s]+?\.md)(?:\)|`)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(canonicalText)) !== null) {
    const raw = m[1].replace(/^\.\//, "")
    // resolve relative to docs/cannon/ (the README's directory)
    const abs = path.resolve(CANNON_DIR, raw)
    allow.add(path.relative(ROOT, abs))
  }
  // The README always describes its own tree; the index file itself is canonical.
  allow.add("docs/cannon/README.md")
  return allow
}

// ── every contract.id literal in production source ───────────────────────────
interface ContractRef {
  readonly file: string
  readonly line: number
  readonly target: string
}
const collectTs = (dir: string, out: Array<string> = []): Array<string> => {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === "test") continue
      collectTs(full, out)
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(full)
  }
  return out
}
const collectContractRefs = (): Array<ContractRef> => {
  const refs: Array<ContractRef> = []
  const pkgRoot = path.join(ROOT, "packages")
  const re = /"firegrid\.contract\.id"\s*:\s*"([^"]+)"/
  for (const pkg of fs.readdirSync(pkgRoot)) {
    for (const file of collectTs(path.join(pkgRoot, pkg, "src"))) {
      const lines = fs.readFileSync(file, "utf8").split("\n")
      lines.forEach((text, i) => {
        const m = re.exec(text)
        if (m) refs.push({ file: path.relative(ROOT, file), line: i + 1, target: m[1] })
      })
    }
  }
  return refs
}

// ─────────────────────────────────────────────────────────────────────────────
const main = () => {
  const allow = buildAllowlist()
  const refs = collectContractRefs()
  const violations: Array<{ ref: ContractRef; reason: string }> = []
  for (const ref of refs) {
    const t = ref.target.replace(/^\.\//, "")
    // This gate governs only the cannon docs namespace. contract.id also names
    // feature-spec files (`features/*.feature.yaml`) and feature ACIDs
    // (`firegrid-*.STAGES.n`); those belong to the feature/ACID ledger and are
    // out of scope here.
    if (!t.startsWith("docs/")) continue
    if (t.startsWith("docs/sdds/_archive/")) {
      violations.push({ ref, reason: "points at an ARCHIVED (historical) doc" })
    } else if (!fs.existsSync(path.join(ROOT, t))) {
      violations.push({ ref, reason: "target file does not exist" })
    } else if (!allow.has(t)) {
      violations.push({ ref, reason: "not in the docs/cannon/README.md canonical allowlist" })
    }
  }

  const log = (s = "") => process.stdout.write(s + "\n")
  log(`canonical contract.id gate — ${refs.length} contract.id span(s), ${allow.size} allowlisted canonical docs`)
  if (violations.length === 0) {
    log("✓ all contract.id span attributes point at a canonical doc")
    return
  }
  log(`✗ ${violations.length} contract.id violation(s):`)
  for (const { ref, reason } of violations) {
    log(`  ${ref.file}:${ref.line}  →  ${ref.target}`)
    log(`      ${reason}`)
  }
  log("")
  log("Fix: repoint the span at a canonical doc listed in docs/cannon/README.md,")
  log("or add the intended doc to that allowlist if it is genuinely canonical.")
  process.exit(1)
}

main()
