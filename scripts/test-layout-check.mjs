// firegrid-quality-gates.TEST_LAYOUT.1
// firegrid-quality-gates.TEST_LAYOUT.2
//
// Static gate: a workspace unit's production `src/` tree must not contain
// package tests. Tests live under a sibling `test/` directory at the
// repo-root / package / app / scenario root (see
// docs/contributing/quality-gates.md). The repo-root `src/` (the `firegrid`
// binary) is scanned alongside the pnpm workspace units.
//
// This gate is zero-state: there is no baseline file. Any colocated test is
// a hard failure. If a package/framework genuinely needs an exception, add
// the package directory to `documentedExceptions` below WITH a one-line
// reason and a docs/spec reference — do not silently widen the matcher.

import { error, log } from "node:console"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"

// pnpm-workspace.yaml globs: packages/*, apps/*, scenarios/*
const workspaceRoots = ["packages", "apps", "scenarios"]

const testFilePattern = /\.(?:test|spec)\.(?:c|m)?[jt]sx?$/u

// Directory names that mark a colocated test tree inside production src/.
const testDirNames = new Set(["__tests__", "__test__"])

// Documented, intentional exceptions. Keep empty. Format:
//   "apps/example": "why — docs/contributing/quality-gates.md#section"
const documentedExceptions = new Map()

const failures = []

const collectWorkspaceUnits = () => {
  const units = []
  // Repo root is itself a unit: it ships the `firegrid` binary from `src/`
  // but is not matched by the pnpm-workspace globs above.
  if (existsSync("package.json") && existsSync("src")) units.push(".")
  for (const root of workspaceRoots) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const unitDir = join(root, entry.name)
      if (existsSync(join(unitDir, "package.json"))) units.push(unitDir)
    }
  }
  return units
}

const walkSrc = (dir, unitDir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue
      if (testDirNames.has(entry.name)) {
        failures.push(
          `${full}: colocated test directory under production src/. ` +
            `Move it to ${unitDir}/test/.`,
        )
        continue
      }
      walkSrc(full, unitDir)
      continue
    }
    if (entry.isFile() && testFilePattern.test(entry.name)) {
      failures.push(
        `${full}: test file under production src/. ` +
          `Move it to ${unitDir}/test/ and update its imports + ` +
          `tsconfig/vitest include.`,
      )
    }
  }
}

for (const unitDir of collectWorkspaceUnits()) {
  if (documentedExceptions.has(unitDir)) {
    log(`SKIP ${unitDir} (documented exception: ${documentedExceptions.get(unitDir)})`)
    continue
  }
  const srcDir = join(unitDir, "src")
  if (!existsSync(srcDir)) continue
  walkSrc(srcDir, unitDir)
}

if (failures.length === 0) {
  log("test-layout-check: OK — no tests under any root or workspace src/ tree.")
  process.exit(0)
}

error("test-layout-check: production src/ trees must not contain package tests.")
error("Canonical layout: package tests live under a sibling `<unit>/test/`.")
error("See docs/contributing/quality-gates.md (firegrid-quality-gates.TEST_LAYOUT.1/.2).\n")
for (const failure of failures) error(`- ${failure}`)
error(`\ntest-layout-check failed: ${failures.length} violation(s).`)
process.exit(1)
