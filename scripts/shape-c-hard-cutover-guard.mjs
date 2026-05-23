// Shape-C hard cutover guard.
//
// This is intentionally zero-baseline. The cutover branch is allowed to be
// red until the violations are deleted or rebuilt against the target
// architecture. Do not add carve-outs here; fix the code.

import { error, log } from "node:console"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")

const runtimeSrc = resolve(repoRoot, "packages/runtime/src")
const hostSdkRoot = resolve(repoRoot, "packages/host-sdk")
const hostSdkSrc = join(hostSdkRoot, "src")
const hostSdkTest = join(hostSdkRoot, "test")

const runtimeCanonicalDirs = new Set([
  "_archive",
  "channels",
  "composition",
  "engine",
  "events",
  "producers",
  "subscribers",
  "tables",
  "transforms",
])

const runtimeCanonicalFiles = new Set([
  "README.md",
  "index.ts",
  "runtime-errors.ts",
])

const runtimeLegacyRoots = [
  "agent-adapters",
  "agent-event-pipeline",
  "authorities",
  "control-plane",
  "kernel",
  "runtime-keyed-subscriber",
  "streams",
  "verified-webhook-ingest",
  "workflow-engine",
]

const hostSdkForbiddenRuntimeRoots = [
  "_archive",
  "agent-adapters",
  "agent-event-pipeline",
  "authorities",
  "control-plane",
  "kernel",
  "runtime-keyed-subscriber",
  "streams",
  "verified-webhook-ingest",
  "workflow-engine",
]

const hostSdkAllowedRuntimeSegments = new Set([
  "channels",
  "composition",
  "engine",
  "events",
  "producers",
  "subscribers",
  "tables",
  "transforms",
])

const bridgeSymbols = [
  "RuntimeContextWorkflowNative",
  "RuntimeContextWorkflowRuntime",
  "RuntimeContextWorkflowRuntimeLive",
  "RuntimeInputIntentDispatcherLive",
  "executeRuntimeContextWorkflow",
  "RuntimeContextCheckpointSource",
  "RuntimeContextWorkflowCheckpointHandle",
  "appendRuntimeInputDeferred",
  "runtimeInputDeferredFor",
  "runtimeInputDeferredName",
]

const failures = []

const walk = (dir, acc = []) => {
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

const sourceFiles = (dir) =>
  walk(dir).filter((file) => /\.(?:[cm]?tsx?|jsx?)$/u.test(file))

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"))

const importSpecifierRe =
  /\bimport\s+(?:type\s+)?(?:[^"']+\s+from\s+)?["']([^"']+)["']|\bexport\s+(?:type\s+)?(?:[^"']+\s+from\s+)?["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g

const collectImports = (file) => {
  const text = readFileSync(file, "utf8")
  const lines = text.split("\n")
  const imports = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    importSpecifierRe.lastIndex = 0
    let match
    while ((match = importSpecifierRe.exec(line)) !== null) {
      imports.push({
        file: relative(repoRoot, file),
        line: i + 1,
        specifier: match[1] ?? match[2] ?? match[3] ?? match[4],
        source: line.trim(),
      })
    }
  }
  return imports
}

const addFindings = (title, findings) => {
  if (findings.length === 0) return
  failures.push(
    `${title}\n` +
      findings
        .map((hit) =>
          `  - ${hit.file}${hit.line === undefined ? "" : `:${hit.line}`} ${hit.detail ?? hit.specifier ?? ""}`.trimEnd()
        )
        .join("\n"),
  )
}

// 1. host-sdk must not depend on @effect/workflow.
const hostPackageJson = join(hostSdkRoot, "package.json")
if (existsSync(hostPackageJson)) {
  const pkg = readJson(hostPackageJson)
  const depBuckets = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]
  const hits = []
  for (const bucket of depBuckets) {
    if (pkg[bucket]?.["@effect/workflow"] !== undefined) {
      hits.push({
        file: relative(repoRoot, hostPackageJson),
        detail: `${bucket}.@effect/workflow`,
      })
    }
  }
  addFindings(
    "host-sdk dependency hard stop: @effect/workflow is forbidden.",
    hits,
  )
}

// 2. host-sdk src/test must not import @effect/workflow or forbidden runtime roots.
const hostImportHits = []
const hostRuntimeHits = []
for (const file of [...sourceFiles(hostSdkSrc), ...sourceFiles(hostSdkTest)]) {
  for (const hit of collectImports(file)) {
    if (hit.specifier === "@effect/workflow" || hit.specifier.startsWith("@effect/workflow/")) {
      hostImportHits.push(hit)
      continue
    }
    if (hit.specifier === "@firegrid/runtime") {
      hostRuntimeHits.push({ ...hit, detail: "root barrel @firegrid/runtime is forbidden" })
      continue
    }
    if (!hit.specifier.startsWith("@firegrid/runtime/")) continue
    const subpath = hit.specifier.slice("@firegrid/runtime/".length)
    const first = subpath.split("/")[0]
    if (
      hostSdkForbiddenRuntimeRoots.includes(first) ||
      !hostSdkAllowedRuntimeSegments.has(first)
    ) {
      hostRuntimeHits.push(hit)
    }
  }
}
addFindings(
  "host-sdk import hard stop: @effect/workflow imports are forbidden.",
  hostImportHits,
)
addFindings(
  "host-sdk import hard stop: runtime imports must use approved tree-aligned subpaths only.",
  hostRuntimeHits,
)

// 3. runtime top-level must be canonical; old roots are not allowed to exist.
const nonCanonicalRuntimeEntries = []
if (existsSync(runtimeSrc)) {
  for (const entry of readdirSync(runtimeSrc, { withFileTypes: true })) {
    if (entry.isDirectory() && !runtimeCanonicalDirs.has(entry.name)) {
      nonCanonicalRuntimeEntries.push({
        file: relative(repoRoot, join(runtimeSrc, entry.name)),
        detail: "non-canonical runtime root",
      })
    }
    if (entry.isFile() && !runtimeCanonicalFiles.has(entry.name)) {
      nonCanonicalRuntimeEntries.push({
        file: relative(repoRoot, join(runtimeSrc, entry.name)),
        detail: "non-canonical runtime root file",
      })
    }
  }
}
addFindings(
  "runtime root hard stop: packages/runtime/src may contain only canonical target-tree entries.",
  nonCanonicalRuntimeEntries,
)

const legacyRootFiles = []
for (const root of runtimeLegacyRoots) {
  const abs = join(runtimeSrc, root)
  for (const file of sourceFiles(abs)) {
    legacyRootFiles.push({
      file: relative(repoRoot, file),
      detail: "legacy root file must be moved or deleted",
    })
  }
}
addFindings(
  "runtime legacy root hard stop: no production files may remain under legacy roots.",
  legacyRootFiles,
)

// 4. canonical runtime folders may not import legacy roots or _archive.
const targetRuntimeDirs = [
  "channels",
  "composition",
  "engine",
  "events",
  "producers",
  "subscribers",
  "tables",
  "transforms",
]
const targetLegacyImportHits = []
for (const dir of targetRuntimeDirs) {
  for (const file of sourceFiles(join(runtimeSrc, dir))) {
    const fileDir = dirname(file)
    for (const hit of collectImports(file)) {
      let legacy = undefined
      if (hit.specifier.startsWith("@firegrid/runtime/")) {
        const first = hit.specifier.slice("@firegrid/runtime/".length).split("/")[0]
        if (runtimeLegacyRoots.includes(first) || first === "_archive") legacy = first
      } else if (hit.specifier.startsWith(".")) {
        const resolved = resolve(fileDir, hit.specifier)
        const rel = relative(runtimeSrc, resolved)
        const first = rel.split(/[\\/]/u)[0]
        if (runtimeLegacyRoots.includes(first) || first === "_archive") legacy = first
      }
      if (legacy !== undefined) {
        targetLegacyImportHits.push({
          ...hit,
          detail: `${hit.specifier} -> ${legacy}`,
        })
      }
    }
  }
}
addFindings(
  "runtime target-folder hard stop: canonical folders cannot import legacy roots or _archive.",
  targetLegacyImportHits,
)

// 5. Bridge symbols must not appear in production source.
const bridgeRe = new RegExp(`\\b(?:${bridgeSymbols.join("|")})\\b`, "u")
const bridgeHits = []
for (const packageSrc of walk(resolve(repoRoot, "packages")).filter((file) =>
  file.includes("/src/") && /\.(?:[cm]?tsx?)$/u.test(file)
)) {
  const rel = relative(repoRoot, packageSrc)
  if (rel.startsWith("packages/tiny-firegrid/")) continue
  if (rel.includes("/_archive/")) continue
  const lines = readFileSync(packageSrc, "utf8").split("\n")
  for (let i = 0; i < lines.length; i += 1) {
    if (bridgeRe.test(lines[i])) {
      bridgeHits.push({
        file: rel,
        line: i + 1,
        detail: lines[i].trim(),
      })
    }
  }
}
addFindings(
  "bridge-symbol hard stop: deleted runtime-context bridge symbols are forbidden in production source.",
  bridgeHits,
)

// 6. Tests must not read implementation source files by path.
const testSourceReadHits = []
const tests = walk(resolve(repoRoot, "packages")).filter((file) =>
  (file.includes("/test/") || /\.(?:test|spec)\.(?:[cm]?tsx?)$/u.test(file)) &&
  /\.(?:[cm]?tsx?)$/u.test(file)
)
const sourcePathReadRe =
  /readFile\s*\([\s\S]{0,240}new URL\s*\(\s*["'][^"']*(?:\.\.\/)+[^"']*src\//u
for (const file of tests) {
  const lines = readFileSync(file, "utf8").split("\n")
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const window = lines.slice(i, i + 5).join("\n")
    if (
      sourcePathReadRe.test(window) ||
      /access\s*\(\s*new URL\s*\(\s*["'][^"']*(?:\.\.\/)+[^"']*src\//u.test(line) ||
      /new URL\s*\(\s*["'][^"']*(?:\.\.\/)+[^"']*src\//u.test(line)
    ) {
      testSourceReadHits.push({
        file: relative(repoRoot, file),
        line: i + 1,
        detail: line.trim(),
      })
    }
  }
}
addFindings(
  "test hard stop: tests must not chase implementation files with readFile/new URL source-path assertions.",
  testSourceReadHits,
)

if (failures.length > 0) {
  error("shape-c-hard-cutover-guard FAILED")
  error("")
  for (const failure of failures) {
    error(failure)
    error("")
  }
  error(`${failures.length} hard cutover invariant(s) failed.`)
  process.exit(1)
}

log("shape-c-hard-cutover-guard OK")
