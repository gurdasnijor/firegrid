import { error, log } from "node:console"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"

// firegrid-runtime-boundary-reconciliation.PUBLIC_SURFACE.1-.5
// firegrid-runtime-boundary-reconciliation.ROLE_MODEL.4-.6
// firegrid-runtime-boundary-reconciliation.STATIC_ENFORCEMENT.1-.3
//
// Shape C cutover (2026-05-22):
// `events/`, `tables/`, `producers/`, `transforms/`, `channels/`,
// `subscribers/`, `composition/`, and `_archive/` are the semantic target
// surfaces from `docs/architecture/2026-05-22-runtime-physical-target-tree.md`.
// The guard requires them to exist, requires each to ship a README, and
// forbids any numeric `^N-` prefix at the runtime root.

const runtimeSrc = "packages/runtime/src"
const runtimeReadmePath = join(runtimeSrc, "README.md")
const runtimePackagePath = "packages/runtime/package.json"
const runtimeBoundarySddPath =
  "docs/sdds/SDD_FIREGRID_RUNTIME_BOUNDARY_RECONCILIATION.md"

const allowedRuntimeRootFiles = new Set([
  "README.md",
  "index.ts",
  "runtime-errors.ts",
])

const staleRuntimeExportSubpaths = new Set([
  "./agent-codecs",
  "./agent-io",
  "./providers/sandboxes",
])

// Semantic target surfaces from
// docs/architecture/2026-05-22-runtime-physical-target-tree.md. The guard
// REQUIRES each of these to exist as a directory at the runtime root and to
// carry a README.md.
const requiredTargetSurfaces = [
  "events",
  "tables",
  "producers",
  "transforms",
  "channels",
  "subscribers",
  "composition",
  "_archive",
]

const staleRuntimeSourcePaths = [
  "packages/runtime/src/agent-codecs",
  "packages/runtime/src/agent-io",
  "packages/runtime/src/host/authority-context.ts",
  "packages/runtime/src/authorities/registry.ts",
  "packages/runtime/src/codecs",
  "packages/runtime/src/pipeline",
  "packages/runtime/src/sources",
]

const failures = []

const runtimeReadme = readFileSync(runtimeReadmePath, "utf8")
const runtimeBoundarySdd = readFileSync(runtimeBoundarySddPath, "utf8")
const runtimeRootEntries = readdirSync(runtimeSrc, { withFileTypes: true })

for (const entry of runtimeRootEntries) {
  if (entry.isDirectory()) {
    // Numeric-prefix dirs are forbidden at the runtime root: the target tree
    // is semantic, not numbered (docs/architecture/2026-05-22-runtime-physical-target-tree.md).
    if (/^[0-9]+-/.test(entry.name)) {
      failures.push(
        `${entry.name}/: numeric-prefix folder names are forbidden at the runtime root; use semantic dir names per docs/architecture/2026-05-22-runtime-physical-target-tree.md`,
      )
      continue
    }
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

for (const surface of requiredTargetSurfaces) {
  const dirPath = join(runtimeSrc, surface)
  if (!existsSync(dirPath)) {
    failures.push(
      `${dirPath}: required semantic target surface is missing (docs/architecture/2026-05-22-runtime-physical-target-tree.md)`,
    )
    continue
  }
  // _archive/ ships a DEPRECATED.md instead of README.md per the target-tree
  // doc's Archive Rule; every other target surface ships a README.md.
  const readmeName = surface === "_archive" ? "DEPRECATED.md" : "README.md"
  const readmePath = join(dirPath, readmeName)
  if (!existsSync(readmePath)) {
    failures.push(
      `${readmePath}: required target surface is missing ${readmeName}`,
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
