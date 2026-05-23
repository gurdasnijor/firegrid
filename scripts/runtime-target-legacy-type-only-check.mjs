// Type-only target->legacy edge guard.
//
// Background (audit 2026-05-23): `lint:deps` (dep-cruiser) does not see
// type-only imports by default. `import type { Foo } from "..."` is erased
// at the pre-compilation step the cruiser walks, so a target-tree file
// reaching back into the legacy `workflow-engine/`, `agent-event-pipeline/`,
// `authorities/`, `kernel/`, `streams/`, `_archive/`, `control-plane/`,
// or `verified-webhook-ingest/` subtrees via `import type` slips past the
// `runtime-{events,tables,transforms,producers,channels,subscribers,
// composition}-no-legacy-tree-import` family entirely. Source-text grep
// closes that blind spot.
//
// The long-term fix is `tsPreCompilationDeps: true` + rebaseline in
// `.dependency-cruiser.cjs`. Until that lands without re-shaping the wider
// baseline, this script is the temporary belt-and-suspenders ratchet.
//
// Behaviour:
//   - walks every `.ts` under the target tier folders;
//   - matches both `import type { ... } from "..."` and
//     `import { ..., type Foo } from "..."` mixed forms;
//   - if the module specifier resolves to a legacy-subtree root, fail
//     with the file:line and the matched specifier.
//
// Zero-baseline by design as of 2026-05-23: after this PR's
// `subscribers/runtime-context-session/handler.ts` fix (which retargets
// its sole `import type { AgentInputEvent }` from
// `agent-event-pipeline/events/index.ts` to `events/agent-input.ts`),
// there are NO type-only target->legacy edges. New ones fail loud.

import { error, log } from "node:console"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")
const runtimeSrc = resolve(repoRoot, "packages/runtime/src")

const targetTierFolders = [
  "events",
  "tables",
  "transforms",
  "producers",
  "channels",
  "subscribers",
  "composition",
]

const legacyRootNames = [
  "workflow-engine",
  "agent-event-pipeline",
  "authorities",
  "kernel",
  "streams",
  "_archive",
  "control-plane",
  "verified-webhook-ingest",
]

// Captures the specifier in a `from "..."` clause.
const fromSpecifier = /from\s+"([^"]+)"/

// Identifies a type-only import. Two shapes catch the common cases:
//  - `import type { Foo } from "..."` (whole-statement type-only)
//  - `import { type Foo, Bar } from "..."` (mixed; the inner `type` keyword
//    marks the named binding alone as type-only — dep-cruiser still sees
//    `Bar`, but a hit here is informational anyway).
const typeOnlyImport = /^\s*import\s+(?:type\s+)?{[^}]*\btype\s+\w/
const typeOnlyStatement = /^\s*import\s+type\s+/

const walkTs = (dir, acc) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkTs(full, acc)
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      acc.push(full)
    }
  }
  return acc
}

const findings = []

for (const folder of targetTierFolders) {
  const abs = join(runtimeSrc, folder)
  if (!existsSync(abs)) continue
  const files = []
  walkTs(abs, files)
  for (const file of files) {
    const text = readFileSync(file, "utf8")
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i]
      if (!typeOnlyImport.test(raw) && !typeOnlyStatement.test(raw)) continue
      const match = fromSpecifier.exec(raw)
      if (match === null) continue
      const specifier = match[1]
      // Relative specifiers are evaluated against the target subtree
      // segment; reject anything that climbs back into a legacy root.
      // Public subpath specifiers (`@firegrid/runtime/<root>`) are also
      // matched here so a target-tree file does not legitimise the edge
      // by going through the package barrel.
      const matchedLegacy = legacyRootNames.find((root) => {
        const relativePattern = new RegExp(`(^|/)${root}(/|$)`)
        const packagePattern = new RegExp(`^@firegrid/runtime/${root}(/|$)`)
        return relativePattern.test(specifier) || packagePattern.test(specifier)
      })
      if (matchedLegacy === undefined) continue
      findings.push({
        file: relative(repoRoot, file),
        line: i + 1,
        specifier,
        legacyRoot: matchedLegacy,
      })
    }
  }
}

if (findings.length > 0) {
  error("Type-only target->legacy edge(s) detected (dep-cruiser blind spot):")
  for (const finding of findings) {
    error(
      `- ${finding.file}:${finding.line} -> ${finding.specifier} (${finding.legacyRoot})`,
    )
  }
  error("")
  error(
    "These are `import type` edges from a target-tier folder into a legacy root. " +
      "Resolve by importing from the target-tree home (e.g. events/, tables/) instead.",
  )
  process.exit(1)
}

log(
  `Type-only target->legacy edge check OK: 0 edges across ${targetTierFolders.length} target-tier folder(s).`,
)
