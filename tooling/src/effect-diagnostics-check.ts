// Per-package Effect diagnostics gate — the `diagnostics` turbo task.
//
// Runs effect-language-service for ONE package (the cwd turbo invokes it in) and
// enforces STRICT-ZERO effect diagnostics in that package's PRODUCTION SOURCE
// (`src/**`). Because it is a per-package turbo task keyed on the package's src +
// tsconfig, turbo skips the (seconds-long) language-service run for any package
// whose inputs are unchanged.
//
// Test files are NOT gated: they legitimately use patterns the language service
// flags (e.g. `new Error` in fixtures, try/catch, multiple `Effect.provide`),
// mirroring the ESLint type-aware rules' test exemption.
//
// tf-ov4w: the previous baseline ratchet (per-package
// `.effect-diagnostics-baseline.json`, grandfathering existing findings) was
// deleted — the last baseline-JSON gate in the repo. Genuine src diagnostics are
// fixed at the site; the few rules that false-positive or flag legitimate raw-IO
// boundaries carry documented inline `// @effect-diagnostics <rule>:off` directives.

import { spawnSync } from "node:child_process"
import { error, log } from "node:console"
import { existsSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const pkgDir = process.cwd()
const project = relative(repoRoot, join(pkgDir, "tsconfig.json"))

// Dependency guard (mirrors tooling/src/preflight.ts): the language-service lives
// in node_modules/.bin; a fresh worktree without an install would otherwise fail
// with a cryptic "spawn ENOENT".
if (!existsSync(join(repoRoot, "node_modules"))) {
  error(
    "\neffect:diagnostics: dependencies are not installed (missing: node_modules).\n" +
      "Run `pnpm install` in this worktree, then re-run.\n",
  )
  process.exit(1)
}

// Production source only — test files are not gated (see header).
const isTestFile = (file: string) =>
  file.endsWith(".test.ts") ||
  file.endsWith(".test.tsx") ||
  file.endsWith(".spec.ts") ||
  file.includes("/__tests__/") ||
  file.includes("/test/")

// Shape of one entry in the effect-language-service `--format json` output.
interface RawDiagnostic {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly severity: string
  readonly name: string
  readonly message: string
}
interface LanguageServiceOutput {
  readonly diagnostics?: ReadonlyArray<RawDiagnostic>
}
// Our normalized, repo-root-relative diagnostic.
interface Diagnostic {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly severity: string
  readonly code: string
  readonly message: string
}

const sortKey = (entry: Diagnostic) =>
  [entry.file, String(entry.line), String(entry.column), entry.severity, entry.code].join(" ")

// Collect this package's current production-source diagnostics from the
// language-service JSON format. `name` is the effect rule id; `code` in JSON is a
// numeric id we don't use. Paths are made repo-root-relative for stable output.
const collect = () => {
  const result = spawnSync(
    "pnpm",
    ["exec", "effect-language-service", "diagnostics", "--project", "tsconfig.json", "--format", "json"],
    { cwd: pkgDir, encoding: "utf8", env: process.env },
  )
  if (result.error !== undefined) {
    error(result.error.message)
    process.exit(1)
  }
  if (result.status !== 0 && result.stdout.length === 0) {
    if (result.stderr.length > 0) process.stderr.write(result.stderr)
    error(`effect-language-service exited ${String(result.status)} for ${project}`)
    process.exit(result.status ?? 1)
  }
  let parsed: LanguageServiceOutput
  try {
    parsed = JSON.parse(result.stdout) as LanguageServiceOutput
  } catch {
    error(`Could not parse effect-language-service JSON output for ${project}.`)
    if (result.stderr.length > 0) process.stderr.write(result.stderr)
    process.exit(1)
  }
  return (parsed.diagnostics ?? [])
    .map((d): Diagnostic => ({
      file: relative(repoRoot, d.file),
      line: d.line,
      column: d.column,
      severity: d.severity,
      code: d.name,
      message: d.message,
    }))
    .filter((d) => !isTestFile(d.file))
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
}

const diagnostics = collect()
if (diagnostics.length === 0) {
  log(`${project}: effect diagnostics OK (0 in production src).`)
} else {
  error(
    `${project}: ${String(diagnostics.length)} effect diagnostic(s) in production src (strict-0 — fix the site or add a documented \`// @effect-diagnostics <rule>:off\`):`,
  )
  for (const d of diagnostics) {
    error(`${d.file}:${String(d.line)}:${String(d.column)} ${d.severity} effect(${d.code}) ${d.message}`)
  }
  process.exit(1)
}
