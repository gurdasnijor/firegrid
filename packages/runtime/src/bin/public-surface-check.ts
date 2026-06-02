#!/usr/bin/env tsx
/**
 * firegrid-runtime-boundary-reconciliation.PUBLIC_SURFACE.1-.5
 * firegrid-runtime-boundary-reconciliation.ROLE_MODEL.4-.6
 * firegrid-runtime-boundary-reconciliation.STATIC_ENFORCEMENT.1-.3
 *
 * Shape C cutover (2026-05-22) + SDD #761 source/producer split (PR-M1):
 * events/, capabilities/, tables/, sources/, producers/, transforms/,
 * channels/, unified/, and _archive/ are the semantic target surfaces from
 * docs/architecture/2026-05-22-runtime-physical-target-tree.md. The guard
 * requires them to exist, requires each to ship a README (DEPRECATED.md for
 * _archive), and forbids any numeric `^N-` prefix at the runtime root.
 *
 * Effect-native (FileSystem/Path); the runtime no-filesystem rule exempts
 * src/bin/. Paths resolve off this module's URL so it is cwd-independent.
 */
import { FileSystem, Path } from "@effect/platform"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Console, Effect } from "effect"

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

// Semantic target surfaces — each REQUIRED as a runtime-root directory with a
// README (docs/architecture/2026-05-22-runtime-physical-target-tree.md).
const requiredTargetSurfaces = [
  "events",
  "capabilities",
  "tables",
  "sources",
  "producers",
  "transforms",
  "channels",
  "unified",
  "_archive",
]

const staleRuntimeSourcePaths = [
  "packages/runtime/src/agent-codecs",
  "packages/runtime/src/agent-io",
  "packages/runtime/src/host/authority-context.ts",
  // This gate asserts the legacy authority-registry surface is ABSENT — the
  // path string below is data the check looks for, not a surface this file
  // defines. Exempt that one line from the runtime authority source guard.
  // eslint-disable-next-line local/sg-runtime-no-authority-registry-surface
  "packages/runtime/src/authorities/registry.ts",
  "packages/runtime/src/codecs",
  "packages/runtime/src/pipeline",
]

// Display paths (relative to repo root); fs reads join them onto repoRoot.
const runtimeSrcDisplay = "packages/runtime/src"
const runtimeReadmeDisplay = "packages/runtime/src/README.md"
const runtimePackageDisplay = "packages/runtime/package.json"
const runtimeBoundarySddDisplay = "docs/sdds/SDD_FIREGRID_RUNTIME_BOUNDARY_RECONCILIATION.md"

const repoRootUrl = new URL("../../../../", import.meta.url)

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const repoRoot = yield* path.fromFileUrl(repoRootUrl)
  const abs = (rel: string): string => path.join(repoRoot, rel)

  const runtimeReadme = yield* fs.readFileString(abs(runtimeReadmeDisplay))
  const runtimeBoundarySdd = yield* fs.readFileString(abs(runtimeBoundarySddDisplay))

  // Runtime-root entries: dirs must be documented + non-numeric-prefixed; files
  // must be on the allowlist.
  const rootEntries = yield* fs.readDirectory(abs(runtimeSrcDisplay))
  const rootFailures = yield* Effect.forEach(rootEntries, name =>
    Effect.map(fs.stat(abs(`${runtimeSrcDisplay}/${name}`)), stat => {
      if (stat.type === "Directory") {
        if (/^[0-9]+-/.test(name)) {
          return [
            `${name}/: numeric-prefix folder names are forbidden at the runtime root; use semantic dir names per docs/architecture/2026-05-22-runtime-physical-target-tree.md`,
          ]
        }
        const documentedInReadme =
          runtimeReadme.includes(`\`${name}/\``) ||
          runtimeReadme.includes(`./${name}/`) ||
          runtimeReadme.includes(`](./${name})`)
        const documentedInSdd =
          runtimeBoundarySdd.includes(`\`${name}/\``) ||
          runtimeBoundarySdd.includes(`${name}/`)
        return [
          ...(documentedInReadme ? [] : [`${name}/: missing documented role in ${runtimeReadmeDisplay}`]),
          ...(documentedInSdd ? [] : [`${name}/: missing documented role in ${runtimeBoundarySddDisplay}`]),
        ]
      }
      if (stat.type === "File" && !allowedRuntimeRootFiles.has(name)) {
        return [`${runtimeSrcDisplay}/${name}: top-level runtime source file is not part of the public-surface allowlist`]
      }
      return [] as ReadonlyArray<string>
    }))

  // Required semantic target surfaces must exist and carry their README.
  const surfaceFailures = yield* Effect.forEach(requiredTargetSurfaces, surface =>
    Effect.gen(function*() {
      const dirRel = `${runtimeSrcDisplay}/${surface}`
      if (!(yield* fs.exists(abs(dirRel)))) {
        return [
          `${dirRel}: required semantic target surface is missing (docs/architecture/2026-05-22-runtime-physical-target-tree.md)`,
        ]
      }
      // _archive/ ships a DEPRECATED.md per the target-tree Archive Rule.
      const readmeName = surface === "_archive" ? "DEPRECATED.md" : "README.md"
      const readmeRel = `${dirRel}/${readmeName}`
      if (!(yield* fs.exists(abs(readmeRel)))) {
        return [`${readmeRel}: required target surface is missing ${readmeName}`]
      }
      return [] as ReadonlyArray<string>
    }))

  // Stale source paths must not exist.
  const staleFailures = (yield* Effect.forEach(staleRuntimeSourcePaths, rel =>
    Effect.map(fs.exists(abs(rel)), exists =>
      exists ? `${rel}: stale runtime compatibility/review surface must not exist` : ""))).filter(
    message => message.length > 0,
  )

  // Stale export subpaths in the runtime package.json.
  const runtimePackage = JSON.parse(
    yield* fs.readFileString(abs(runtimePackageDisplay)),
  ) as { readonly exports?: Record<string, unknown> }
  const exportFailures = Object.keys(runtimePackage.exports ?? {})
    .filter(subpath => staleRuntimeExportSubpaths.has(subpath))
    .map(subpath => `${runtimePackageDisplay}: stale runtime export subpath ${subpath}`)

  const failures = [
    ...rootFailures.flat(),
    ...surfaceFailures.flat(),
    ...staleFailures,
    ...exportFailures,
  ]

  if (failures.length > 0) {
    yield* Console.error("Runtime public-surface boundary check failed:")
    yield* Effect.forEach(failures, failure => Console.error(`- ${failure}`))
    yield* Effect.sync(() => {
      process.exitCode = 1
    })
    return
  }

  yield* Console.log("Runtime public-surface boundary check OK")
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeContext.layer)))
