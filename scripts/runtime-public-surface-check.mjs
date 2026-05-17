import { error, log } from "node:console"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"

// firegrid-runtime-boundary-reconciliation.PUBLIC_SURFACE.1-.5
// firegrid-runtime-boundary-reconciliation.ROLE_MODEL.4-.6
// firegrid-runtime-boundary-reconciliation.STATIC_ENFORCEMENT.1-.3

const runtimeSrc = "packages/runtime/src"
const runtimeReadmePath = join(runtimeSrc, "README.md")
const runtimePackagePath = "packages/runtime/package.json"
const runtimeBoundarySddPath =
  "docs/sdds/SDD_FIREGRID_RUNTIME_BOUNDARY_RECONCILIATION.md"

const allowedRuntimeRootFiles = new Set([
  "README.md",
  "index.ts",
  "runtime-errors.ts",
  // firegrid-host-sdk.TOOL_EXECUTOR_SEAM / PACKAGE_GRAPH.2: narrow
  // runtime composition surface @firegrid/host-sdk imports instead of
  // the root barrel.
  "host-substrate.ts",
])

const staleRuntimeExportSubpaths = new Set([
  "./agent-codecs",
  "./agent-io",
  "./providers/sandboxes",
])

const staleRuntimeSourcePaths = [
  "packages/runtime/src/agent-codecs",
  "packages/runtime/src/agent-io",
  "packages/runtime/src/host/authority-context.ts",
  "packages/runtime/src/authorities/registry.ts",
  "packages/runtime/src/codecs",
  "packages/runtime/src/events",
  "packages/runtime/src/pipeline",
  "packages/runtime/src/sources",
  "packages/runtime/src/subscribers",
  "packages/runtime/src/transforms",
]

const failures = []

const runtimeReadme = readFileSync(runtimeReadmePath, "utf8")
const runtimeBoundarySdd = readFileSync(runtimeBoundarySddPath, "utf8")
const runtimeRootEntries = readdirSync(runtimeSrc, { withFileTypes: true })

for (const entry of runtimeRootEntries) {
  if (entry.isDirectory()) {
    const documentedInReadme =
      runtimeReadme.includes(`\`${entry.name}/\``) ||
      runtimeReadme.includes(`./${entry.name}/`) ||
      runtimeReadme.includes(`](./${entry.name})`)
    const documentedInSdd =
      runtimeBoundarySdd.includes(`\`${entry.name}/\``) ||
      runtimeBoundarySdd.includes(`${entry.name}/`)
    if (!documentedInReadme) {
      failures.push(
        `${entry.name}/: missing documented role in ${runtimeReadmePath}`,
      )
    }
    if (!documentedInSdd) {
      failures.push(
        `${entry.name}/: missing documented role in ${runtimeBoundarySddPath}`,
      )
    }
    continue
  }

  if (entry.isFile() && !allowedRuntimeRootFiles.has(entry.name)) {
    failures.push(
      `${runtimeSrc}/${entry.name}: top-level runtime source file is not part of the public-surface allowlist`,
    )
  }
}

for (const path of staleRuntimeSourcePaths) {
  if (existsSync(path)) {
    failures.push(`${path}: stale runtime compatibility/review surface must not exist`)
  }
}

const runtimePackage = JSON.parse(readFileSync(runtimePackagePath, "utf8"))
const runtimeExports = Object.keys(runtimePackage.exports ?? {})
for (const subpath of runtimeExports) {
  if (staleRuntimeExportSubpaths.has(subpath)) {
    failures.push(`${runtimePackagePath}: stale runtime export subpath ${subpath}`)
  }
}

if (failures.length > 0) {
  error("Runtime public-surface boundary check failed:")
  for (const failure of failures) error(`- ${failure}`)
  process.exit(1)
}

log("Runtime public-surface boundary check OK")
