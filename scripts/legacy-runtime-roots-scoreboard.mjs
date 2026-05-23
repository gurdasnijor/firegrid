// Wave-D / D-D / E cleanup-wave preservation scoreboard.
//
// Source: docs/architecture/2026-05-22-shape-c-cutover-roadmap.md §"Wave D"
// /§"Wave E"; docs/architecture/2026-05-22-runtime-physical-target-tree.md.
//
// The three legacy runtime roots (`kernel/`, `workflow-engine/`, `streams/`)
// are bridge surfaces scheduled for deletion. Every preserved file under
// them must have an explicit PARK entry below naming the owner and the
// deletion wave. The script always prints the per-root line counts
// (preservation visible) and FAILS when:
//
//   - a `.ts` file exists in a legacy root but has no PARK entry; OR
//   - a PARK entry names a file that no longer exists on disk.
//
// This produces a tight ratchet: shrinking the legacy roots requires
// deleting the file AND its PARK entry in the same PR. Adding any new file
// to a legacy root requires an explicit PARK with owner + wave (i.e.
// preservation becomes visible at PR time, not at audit time).
//
// _archive/ is intentionally excluded — it is governed by its own
// `DEPRECATED.md` contract (target tree §Archive Rule) and its emptiness
// is the Wave E exit gate.

import { error, log } from "node:console"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")

const legacyRoots = [
  "packages/runtime/src/kernel",
  "packages/runtime/src/workflow-engine",
  "packages/runtime/src/streams",
]

// Explicit PARK allowlist. Every preserved `.ts` file under a legacy root
// MUST appear here. `owner` is the lane handle currently responsible for
// the file's deletion; `wave` is the cutover-roadmap wave the deletion is
// scheduled in (Wave D = behavior-proof + paired deletion; D-input,
// D-tool, D-D wait/child-output, D-control are sub-lanes).
const parkAllowlist = {
  // -- packages/runtime/src/kernel/ -----------------------------------
  // Wave D / Wave E body: legacy RuntimeContext body driver, helpers,
  // and barrel; deleted alongside the Shape C cutover behavior proofs
  // (roadmap §"Wave D" input/restart, §"Wave E" public-surface shrink).
  "packages/runtime/src/kernel/index.ts": {
    owner: "rearch-shape-c",
    wave: "D",
  },
  // Body+kernel deletion wave: `kernel/internal/run-context-workflow.ts`
  // and `kernel/runtime-context-workflow-runtime.ts` deleted with the
  // workflow body retirement; entries removed.
  "packages/runtime/src/kernel/runtime-context-helpers.ts": {
    owner: "rearch-shape-c",
    wave: "D",
  },
  "packages/runtime/src/kernel/runtime-host-config.ts": {
    owner: "rearch-shape-c",
    wave: "D",
  },

  // -- packages/runtime/src/workflow-engine/ --------------------------
  // The legacy body, per-sequence input deferred mailbox, and engine
  // internals all retire in Wave D-input (legacy body + mailbox) and
  // Wave D-D (wait/child-output). Shape D workflows (tool-call, wait-
  // for, scheduled-prompt, runtime-control-request) graduate to
  // `subscribers/{tool-dispatch,wait-router,scheduled-prompt,runtime-
  // control}/` per the target tree.
  "packages/runtime/src/workflow-engine/DurableStreamsWorkflowEngine.ts": {
    owner: "rearch-shape-c",
    wave: "D",
  },
  "packages/runtime/src/workflow-engine/index.ts": {
    owner: "rearch-shape-c",
    wave: "E",
  },
  "packages/runtime/src/workflow-engine/internal/codec.ts": {
    owner: "rearch-shape-c",
    wave: "D",
  },
  "packages/runtime/src/workflow-engine/internal/contract-activity.ts": {
    owner: "rearch-shape-c",
    wave: "D",
  },
  "packages/runtime/src/workflow-engine/internal/engine-runtime.ts": {
    owner: "rearch-shape-c",
    wave: "D",
  },
  "packages/runtime/src/workflow-engine/internal/table.ts": {
    owner: "rearch-shape-c",
    wave: "D",
  },
  // Body+kernel deletion wave: per-sequence DurableDeferred input mailbox
  // (`runtime-input-deferred.ts`) deleted; entry removed.
  // Tool-dispatch source relocation wave: workflow-engine/tool-execution/
  // directory deleted; `RuntimeToolUseExecutor` physically moved to
  // `subscribers/tool-dispatch/runtime-tool-use-executor.ts`. Entry removed.
  "packages/runtime/src/workflow-engine/workflows/index.ts": {
    owner: "rearch-shape-c",
    wave: "E",
  },
  "packages/runtime/src/workflow-engine/workflows/runtime-context-run.ts": {
    owner: "rearch-shape-c",
    wave: "D-input",
  },
  // Body+kernel deletion wave: workflow body
  // (`workflows/runtime-context.ts`) deleted; entry removed.
  "packages/runtime/src/workflow-engine/workflows/runtime-control-request.ts":
    {
      owner: "rearch-shape-c",
      wave: "D-control",
    },
  "packages/runtime/src/workflow-engine/workflows/runtime-ingress-transform.ts":
    {
      owner: "rearch-shape-c",
      wave: "D-input",
    },
  "packages/runtime/src/workflow-engine/workflows/scheduled-prompt.ts": {
    owner: "rearch-shape-c",
    wave: "D",
  },
  // Tool-dispatch source relocation wave: `ToolCallWorkflow` physically
  // moved to `subscribers/tool-dispatch/workflow.ts`. Entry removed.
  "packages/runtime/src/workflow-engine/workflows/wait-for.ts": {
    owner: "rearch-shape-c",
    wave: "D-D",
  },

  // -- packages/runtime/src/streams/ -----------------------------------
  // Wave D-D: route-based observation through the channel router replaces
  // the `RuntimeObservationStreams` / `CallerOwnedFactStreams` Tag family
  // for wait/child-output. The verified-webhook adapter is the named
  // PARK blocker on the final `CallerOwnedFactStreams` deletion (see
  // PR #716 FINDING.md).
  "packages/runtime/src/streams/index.ts": {
    owner: "rearch-shape-c",
    wave: "D-D",
  },
  "packages/runtime/src/streams/runtime-observation-streams.ts": {
    owner: "rearch-shape-c",
    wave: "D-D",
  },
  "packages/runtime/src/streams/sources.ts": {
    owner: "rearch-shape-c",
    wave: "D-D",
  },
}

const failures = []

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

const countNonBlank = (file) => {
  const text = readFileSync(file, "utf8")
  let n = 0
  for (const line of text.split("\n")) if (line.trim().length > 0) n += 1
  return n
}

const formatRow = (path, lines, entry) => {
  const owner = entry ? entry.owner : "<MISSING>"
  const wave = entry ? entry.wave : "<MISSING>"
  return `  ${String(lines).padStart(5)}  [${wave.padEnd(8)}]  [${owner.padEnd(16)}]  ${path}`
}

const presentFiles = new Set()
let totalLines = 0
let totalFiles = 0

log("Legacy runtime roots scoreboard")
log("  source: docs/architecture/2026-05-22-shape-c-cutover-roadmap.md")
log("          docs/architecture/2026-05-22-runtime-physical-target-tree.md")
log("")

for (const root of legacyRoots) {
  const abs = resolve(repoRoot, root)
  if (!existsSync(abs)) {
    log(`[${root}]  (absent — Wave E exit gate reached for this root)`)
    log("")
    continue
  }

  const files = []
  try {
    walkTs(abs, files)
  } catch (cause) {
    error(`Failed to walk ${root}: ${String(cause)}`)
    process.exit(1)
  }
  files.sort()

  let rootLines = 0
  log(`[${root}]`)
  if (files.length === 0) {
    log("  (empty — Wave E exit gate reached for this root)")
  }
  for (const abs of files) {
    const rel = relative(repoRoot, abs)
    presentFiles.add(rel)
    const lines = countNonBlank(abs)
    rootLines += lines
    totalLines += lines
    totalFiles += 1
    const entry = parkAllowlist[rel]
    log(formatRow(rel, lines, entry))
    if (entry === undefined) {
      failures.push(
        `${rel}: present in legacy root but has no PARK entry (owner + wave). Add to parkAllowlist in scripts/legacy-runtime-roots-scoreboard.mjs or delete the file.`,
      )
    }
  }
  log(`  ${String(rootLines).padStart(5)} non-blank lines across ${files.length} files`)
  log("")
}

for (const parked of Object.keys(parkAllowlist)) {
  if (!presentFiles.has(parked)) {
    const absPath = resolve(repoRoot, parked)
    // Defense-in-depth: a stale entry would be one the walker didn't reach
    // (e.g. file moved/deleted outside the legacy roots). Confirm absence
    // before flagging.
    if (!existsSync(absPath) || !statSync(absPath).isFile()) {
      failures.push(
        `${parked}: PARK entry exists but file is absent — preserve allowlist accuracy by removing this entry.`,
      )
    }
  }
}

log(
  `Total: ${totalLines} non-blank lines preserved across ${totalFiles} files in ${legacyRoots.length} legacy root(s).`,
)

if (failures.length > 0) {
  error("")
  error("Legacy runtime roots scoreboard FAILED:")
  for (const failure of failures) error(`- ${failure}`)
  process.exit(1)
}

log("Legacy runtime roots scoreboard OK")
