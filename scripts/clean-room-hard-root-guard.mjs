// Clean-room hard-root guard.
//
// This script is the structural barrier that prevents the clean-room
// track of `packages/runtime/src/` from regrowing legacy roots. It is
// **zero-tolerance** — any violation fails with a non-zero exit, and
// there is no baseline/carve-out mechanism by design. The guard is
// greenfield: nothing on the clean-room branch may opt out.
//
// On `rearch/shape-c-cutover` (and any branch that still carries the
// pre-cutover legacy roots) this script will fail. That is the diagnostic
// it is meant to produce: it reports the exact set of non-canonical roots
// and host-sdk import paths that must be deleted before the clean-room
// branch can be considered "clean". The script is NOT wired into the
// default `lint` chain on `rearch/shape-c-cutover` for that reason; the
// clean-room branch wires it in.
//
// Rebuild rule (per the cleanup-wave clarification, 2026-05-23):
// when a legacy-root deletion causes a compile failure, do NOT bring the
// legacy folder back. Instead, rebuild the behavior in a canonical folder
// using the validated tiny-firegrid simulation as the contract:
//
//   - directory pattern: packages/tiny-firegrid/src/simulations/*/FINDING.md
//   - target placements: docs/architecture/2026-05-22-runtime-physical-target-tree.md
//   - wave/lane sequencing: docs/architecture/2026-05-22-shape-c-cutover-roadmap.md
//
// The four checks below are independent — the script reports every
// failure in one run rather than stopping at the first.
//
//   1. packages/runtime/src/ contains only canonical top-level entries
//      ({events, tables, producers, transforms, channels, subscribers,
//       composition, _archive} dirs, plus {README.md, index.ts,
//       runtime-errors.ts} files). No baselines.
//
//   2. _archive/ is not imported by production code (non-test source
//      under any packages/*/src/**). Zero-tolerance.
//
//   3. packages/host-sdk/src/** imports of @firegrid/runtime/* go ONLY
//      through public tree-aligned subpaths whose first segment is one
//      of {events, tables, transforms, channels, subscribers,
//      producers, composition}. _archive is forbidden in host-sdk
//      regardless. Any other first segment (the legacy roots
//      {kernel, workflow-engine, streams, agent-adapters, authorities,
//      control-plane, verified-webhook-ingest, runtime-keyed-subscriber}
//      and any ad-hoc flat subpath like ./errors, ./codecs,
//      ./tool-executor, ./workflows, etc.) fails.
//
//   4. The runtime root barrel `@firegrid/runtime` is forbidden in
//      host-sdk (already covered by the ESLint `local/sg-host-sdk-imports`
//      rule; the script re-asserts it for completeness).

import { error, log } from "node:console"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")

const CANONICAL_RUNTIME_DIRS = new Set([
  "events",
  "capabilities",
  "tables",
  "sources",
  "producers",
  "transforms",
  "channels",
  "subscribers",
  "composition",
  "engine",
  "bin",
  "verified-webhook-ingest",
  "_archive",
])

// The runtime root may carry README.md (folder docs), index.ts (public
// root barrel), and runtime-errors.ts (runtime-internal error namespace).
// Any other top-level file fails.
const CANONICAL_RUNTIME_TOP_FILES = new Set([
  "README.md",
  "index.ts",
  "runtime-errors.ts",
])

const TREE_ALIGNED_FIRST_SEGMENTS = new Set([
  "events",
  "capabilities",
  "tables",
  "sources",
  "transforms",
  "channels",
  "subscribers",
  "producers",
  "composition",
])

const runtimeSrcDir = resolve(repoRoot, "packages/runtime/src")
const hostSdkSrcDir = resolve(repoRoot, "packages/host-sdk/src")

const failures = []

const rebuildPointer = () =>
  "  Rebuild guidance: do NOT reintroduce a legacy folder to keep a cutover\n" +
  "  moving. The clean-room rule is to rebuild the missing behavior in a\n" +
  "  canonical folder using the validated tiny-firegrid simulation as the\n" +
  "  contract.\n" +
  "    sim findings: packages/tiny-firegrid/src/simulations/*/FINDING.md\n" +
  "    target tree:  docs/architecture/2026-05-22-runtime-physical-target-tree.md\n" +
  "    wave order:   docs/architecture/2026-05-22-shape-c-cutover-roadmap.md"

// ---------------------------------------------------------------------------
// Check 1 — packages/runtime/src top-level allowlist
// ---------------------------------------------------------------------------

const nonCanonicalDirs = []
const nonCanonicalFiles = []

if (!existsSync(runtimeSrcDir)) {
  failures.push(
    `[check-1] ${relative(repoRoot, runtimeSrcDir)} does not exist.`,
  )
} else {
  for (const entry of readdirSync(runtimeSrcDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!CANONICAL_RUNTIME_DIRS.has(entry.name)) {
        nonCanonicalDirs.push(entry.name)
      }
    } else if (entry.isFile()) {
      if (!CANONICAL_RUNTIME_TOP_FILES.has(entry.name)) {
        nonCanonicalFiles.push(entry.name)
      }
    }
  }
}

if (nonCanonicalDirs.length > 0 || nonCanonicalFiles.length > 0) {
  const dirList = nonCanonicalDirs.length > 0
    ? `\n    non-canonical dirs:  ${nonCanonicalDirs.sort().join(", ")}`
    : ""
  const fileList = nonCanonicalFiles.length > 0
    ? `\n    non-canonical files: ${nonCanonicalFiles.sort().join(", ")}`
    : ""
  failures.push(
    `[check-1] packages/runtime/src contains entries outside the canonical allowlist.\n` +
      `    allowed dirs:        ${[...CANONICAL_RUNTIME_DIRS].sort().join(", ")}\n` +
      `    allowed files:       ${[...CANONICAL_RUNTIME_TOP_FILES].sort().join(", ")}` +
      dirList +
      fileList +
      `\n${rebuildPointer()}`,
  )
}

// ---------------------------------------------------------------------------
// Check 2 — _archive/ has no production importers
// ---------------------------------------------------------------------------

const isProductionSource = (absPath) => {
  const rel = relative(repoRoot, absPath)
  if (!rel.startsWith("packages/")) return false
  if (!rel.includes("/src/")) return false
  // Match test markers in either path or filename position.
  if (/\.(test|spec)\.(?:[cm]?[jt]sx?)$/.test(rel)) return false
  if (rel.includes("/__tests__/")) return false
  if (rel.includes("/test/")) return false
  if (rel.includes("/tests/")) return false
  return rel.endsWith(".ts") || rel.endsWith(".tsx")
    || rel.endsWith(".mts") || rel.endsWith(".cts")
}

const walk = (dir, acc) => {
  if (!existsSync(dir)) return acc
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue
      walk(full, acc)
    } else if (entry.isFile()) {
      acc.push(full)
    }
  }
  return acc
}

const ARCHIVE_IMPORT_PATTERNS = [
  // Relative path crawling back into _archive (any depth).
  /(?:from|import|require)\s*\(?\s*["'][^"']*\/_archive(?:\/|["'])/,
  // Public subpath form.
  /(?:from|import|require)\s*\(?\s*["']@firegrid\/runtime\/_archive(?:\/|["'])/,
]

const archiveImporters = []
const packageRoot = resolve(repoRoot, "packages")
if (existsSync(packageRoot)) {
  for (const file of walk(packageRoot, [])) {
    if (!isProductionSource(file)) continue
    let text
    try {
      text = readFileSync(file, "utf8")
    } catch {
      continue
    }
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (ARCHIVE_IMPORT_PATTERNS.some((re) => re.test(line))) {
        archiveImporters.push({
          file: relative(repoRoot, file),
          line: i + 1,
          source: line.trim(),
        })
      }
    }
  }
}

if (archiveImporters.length > 0) {
  failures.push(
    `[check-2] _archive/ is imported by production code (forbidden — _archive is a deletion holding pen, not a runtime surface):\n` +
      archiveImporters
        .map((hit) => `    - ${hit.file}:${hit.line}    ${hit.source}`)
        .join("\n") +
      `\n${rebuildPointer()}`,
  )
}

// ---------------------------------------------------------------------------
// Checks 3 + 4 — host-sdk runtime import allowlist
// ---------------------------------------------------------------------------

// Capture the runtime subpath portion (after `@firegrid/runtime/`) plus the
// bare-root form (`@firegrid/runtime` with no trailing subpath).
const RUNTIME_IMPORT_RE = /from\s+["']@firegrid\/runtime(\/[^"']*)?["']/g

const hostSdkRuntimeViolations = []

if (existsSync(hostSdkSrcDir)) {
  for (const file of walk(hostSdkSrcDir, [])) {
    if (!isProductionSource(file)) continue
    let text
    try {
      text = readFileSync(file, "utf8")
    } catch {
      continue
    }
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      RUNTIME_IMPORT_RE.lastIndex = 0
      const match = RUNTIME_IMPORT_RE.exec(line)
      if (match === null) continue
      const trailing = match[1]
      // Bare-root: `@firegrid/runtime`.
      if (trailing === undefined || trailing === "/") {
        hostSdkRuntimeViolations.push({
          file: relative(repoRoot, file),
          line: i + 1,
          kind: "root-barrel",
          subpath: "@firegrid/runtime",
          source: line.trim(),
        })
        continue
      }
      // `@firegrid/runtime/<first>[/...]`.
      const firstSegment = trailing.slice(1).split("/")[0]
      if (firstSegment === "_archive") {
        hostSdkRuntimeViolations.push({
          file: relative(repoRoot, file),
          line: i + 1,
          kind: "archive-import",
          subpath: `@firegrid/runtime${trailing}`,
          source: line.trim(),
        })
        continue
      }
      if (!TREE_ALIGNED_FIRST_SEGMENTS.has(firstSegment)) {
        hostSdkRuntimeViolations.push({
          file: relative(repoRoot, file),
          line: i + 1,
          kind: "non-tree-aligned",
          subpath: `@firegrid/runtime${trailing}`,
          source: line.trim(),
        })
      }
    }
  }
}

if (hostSdkRuntimeViolations.length > 0) {
  const grouped = new Map()
  for (const v of hostSdkRuntimeViolations) {
    const key = v.subpath
    const list = grouped.get(key) ?? []
    list.push(v)
    grouped.set(key, list)
  }
  const groupOrder = [...grouped.keys()].sort()
  const body = groupOrder
    .map((subpath) => {
      const hits = grouped.get(subpath)
      const kind = hits[0].kind
      const head = `    [${kind}] ${subpath} (${hits.length} site${hits.length === 1 ? "" : "s"})`
      const detail = hits
        .map((hit) => `      - ${hit.file}:${hit.line}`)
        .join("\n")
      return `${head}\n${detail}`
    })
    .join("\n")
  failures.push(
    `[check-3+4] packages/host-sdk/src may import @firegrid/runtime ONLY through tree-aligned public subpaths.\n` +
      `    tree-aligned first segments: ${[...TREE_ALIGNED_FIRST_SEGMENTS].sort().join(", ")}\n` +
      `    root barrel and non-tree-aligned subpaths are forbidden; _archive is forbidden.\n` +
      body +
      `\n${rebuildPointer()}`,
  )
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

log("Clean-room hard-root guard — packages/runtime/src structural barrier")
log(`  source: docs/architecture/2026-05-22-runtime-physical-target-tree.md`)
log(`          docs/architecture/2026-05-22-shape-c-cutover-roadmap.md`)
log("")

if (failures.length === 0) {
  log("All checks passed:")
  log(`  1. packages/runtime/src/ top-level entries ⊆ canonical allowlist`)
  log(`  2. _archive/ has no production importers`)
  log(`  3+4. host-sdk runtime imports use tree-aligned subpaths only`)
  log("")
  log(`Clean-room hard-root guard OK.`)
  process.exit(0)
}

error("Clean-room hard-root guard FAILED:")
error("")
for (const f of failures) {
  error(f)
  error("")
}
error(`(${failures.length} failing check${failures.length === 1 ? "" : "s"})`)
process.exit(1)
