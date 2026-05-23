// Wave C host-sdk import quarantine.
//
// Source: docs/architecture/host-sdk-runtime-boundary.md
//   Cannon §3 (no host-sdk @effect/workflow imports — enforced by semgrep
//   `firegrid-host-sdk-no-effect-workflow-import`)
//   Cannon §6 (no host-sdk @firegrid/runtime root barrel — enforced by
//   semgrep `firegrid-host-sdk-no-runtime-root-barrel-import`)
//
// This script covers the *broader* import/symbol quarantine the boundary
// doc names that Semgrep does not already enforce:
//
//   - `@firegrid/runtime/streams` imports (pre-channel/pre-target surface;
//     CC1 Wave C target code uses tree-aligned typed channels instead)
//   - `RuntimeObservationStreams` / `RuntimeObservationSource` symbols
//     (the pre-target observation API the runtime/streams subpath exports)
//   - `@firegrid/runtime/subscribers/runtime-context` (the runtime-owned
//     Shape C handler subpath) and the `handleRuntimeContextEvent` symbol.
//     The architecture owner re-pinned the tiny-firegrid contract: Shape
//     C handler shape/signature questions must be answered in
//     `packages/tiny-firegrid/` before production accumulates speculative
//     driver/runner artifacts in host-sdk. host-sdk installs the runtime
//     root composed in `composition/host-live.ts`; it does not directly
//     wire the per-event handler into a runtime-context-driver loop.
//   - Legacy RuntimeContext body-driver symbols:
//     `RuntimeContextWorkflowNative`, `RuntimeContextWorkflowNativeLayer`,
//     `executeRuntimeContextWorkflow`, `RuntimeContextWorkflowRuntime`
//   - Legacy input-mailbox symbols: `appendRuntimeInputDeferred`,
//     `runtimeInputDeferredFor`, `runtimeInputDeferredName`
//
// Baseline shape mirrors `semgrep-error-baseline.json`: an array of
// `{ ruleId, path, line, note? }` triplets. CI fails on any occurrence
// not present in the baseline. Baseline shrinks as Wave C/D deletion
// lanes retire the residue.
//
// Coverage split with semgrep is intentional and disjoint — each pattern
// is enforced by exactly one gate to avoid double-baseline confusion:
//   semgrep  -> @effect/workflow, @firegrid/runtime root barrel,
//               @firegrid/runtime/kernel, @firegrid/runtime/_archive,
//               numbered runtime subpaths
//   script   -> the patterns enumerated above

import { error, log } from "node:console"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")
const baselinePath = resolve(repoRoot, "host-sdk-runtime-import-baseline.json")
const scanRoot = "packages/host-sdk/src"

const TEST_EXCLUDE = /(?:\.test\.ts|\.test\.tsx|\.test\.mts)$|(?:^|\/)__tests__(?:\/|$)/

// Rule table. Each rule is one line-level regex check.
//
// For path-based rules the regex matches the literal import-source string
// (e.g. `from "@firegrid/runtime/streams"` or `/streams/inner.ts`). For
// symbol-name rules the regex uses `\b` word boundaries so longer
// identifiers don't accidentally match (e.g. `RuntimeContextWorkflowNative`
// does NOT match `RuntimeContextWorkflowNativeLayer`).
const RULES = [
  {
    id: "host-sdk-no-runtime-streams-import",
    label: "@firegrid/runtime/streams import",
    regex: /from\s+["']@firegrid\/runtime\/streams(?:["'/])/,
  },
  {
    id: "host-sdk-no-subscribers-runtime-context-import",
    label: "@firegrid/runtime/subscribers/runtime-context import",
    // Matches the subscribers/runtime-context handler subpath, NOT
    // subscribers/runtime-context-session (the durable-plane session sink
    // host-sdk legitimately implements against). The `(?!-session)` lookahead
    // pins the boundary precisely.
    regex: /from\s+["']@firegrid\/runtime\/subscribers\/runtime-context(?!-session)(?:["'/])/,
  },
  {
    id: "host-sdk-no-handle-runtime-context-event-symbol",
    label: "handleRuntimeContextEvent symbol",
    regex: /\bhandleRuntimeContextEvent\b/,
  },
  {
    id: "host-sdk-no-runtime-observation-streams-symbol",
    label: "RuntimeObservationStreams symbol",
    regex: /\bRuntimeObservationStreams\b/,
  },
  {
    id: "host-sdk-no-runtime-observation-source-symbol",
    label: "RuntimeObservationSource symbol",
    regex: /\bRuntimeObservationSource\b/,
  },
  {
    id: "host-sdk-no-runtime-context-workflow-native-symbol",
    label: "RuntimeContextWorkflowNative symbol",
    regex: /\bRuntimeContextWorkflowNative\b(?!Layer)/,
  },
  {
    id: "host-sdk-no-runtime-context-workflow-native-layer-symbol",
    label: "RuntimeContextWorkflowNativeLayer symbol",
    regex: /\bRuntimeContextWorkflowNativeLayer\b/,
  },
  {
    id: "host-sdk-no-execute-runtime-context-workflow-symbol",
    label: "executeRuntimeContextWorkflow symbol",
    regex: /\bexecuteRuntimeContextWorkflow\b/,
  },
  {
    id: "host-sdk-no-runtime-context-workflow-runtime-symbol",
    label: "RuntimeContextWorkflowRuntime symbol",
    regex: /\bRuntimeContextWorkflowRuntime(?:Live)?\b/,
  },
  {
    id: "host-sdk-no-append-runtime-input-deferred-symbol",
    label: "appendRuntimeInputDeferred symbol",
    regex: /\bappendRuntimeInputDeferred\b/,
  },
  {
    id: "host-sdk-no-runtime-input-deferred-for-symbol",
    label: "runtimeInputDeferredFor symbol",
    regex: /\bruntimeInputDeferredFor\b/,
  },
  {
    id: "host-sdk-no-runtime-input-deferred-name-symbol",
    label: "runtimeInputDeferredName symbol",
    regex: /\bruntimeInputDeferredName\b/,
  },
]

const walk = (dir) => {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...walk(full))
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx") || entry.endsWith(".mts")) {
      const rel = relative(repoRoot, full)
      if (!TEST_EXCLUDE.test(rel)) out.push(rel)
    }
  }
  return out
}

const scan = () => {
  const root = resolve(repoRoot, scanRoot)
  const files = walk(root)
  const findings = []
  for (const file of files) {
    const text = readFileSync(resolve(repoRoot, file), "utf8")
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      for (const rule of RULES) {
        if (rule.regex.test(line)) {
          findings.push({ ruleId: rule.id, path: file, line: i + 1 })
        }
      }
    }
  }
  // Stable ordering for deterministic baseline diffs.
  findings.sort((a, b) =>
    (a.ruleId !== b.ruleId)
      ? a.ruleId.localeCompare(b.ruleId)
      : (a.path !== b.path)
        ? a.path.localeCompare(b.path)
        : a.line - b.line)
  return findings
}

const key = (f) => `${f.ruleId}\0${f.path}\0${f.line}`

const main = () => {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"))
  const allowed = new Map((baseline.findings ?? []).map((f) => [key(f), f]))
  const current = scan()

  let newCount = 0
  for (const f of current) {
    if (!allowed.has(key(f))) {
      const rule = RULES.find((r) => r.id === f.ruleId)
      error(`NEW ${f.ruleId} ${f.path}:${f.line} — ${rule?.label ?? f.ruleId}`)
      newCount++
    }
  }

  const currentKeys = new Set(current.map(key))
  let removedCount = 0
  for (const [k, f] of allowed) {
    if (!currentKeys.has(k)) {
      log(`IMPROVEMENT (remove from baseline): ${f.ruleId} ${f.path}:${f.line}`)
      removedCount++
    }
  }

  if (newCount > 0) {
    error("")
    error(`host-sdk runtime-import quarantine: ${newCount} new occurrence(s) not in baseline.`)
    error(`Baseline lives at host-sdk-runtime-import-baseline.json; add the entry only if the new occurrence is intentional and recorded with its Wave C/D deletion target.`)
    process.exit(1)
  }

  log(`host-sdk runtime-import quarantine OK: current=${current.length}, baseline=${allowed.size}${
    removedCount > 0 ? ` (${removedCount} baseline entries may be removed)` : ""
  }`)
}

if (process.argv.includes("--write-baseline")) {
  const findings = scan()
  const existing = JSON.parse(readFileSync(baselinePath, "utf8"))
  const noteByKey = new Map((existing.findings ?? [])
    .filter((f) => f.note !== undefined)
    .map((f) => [key(f), f.note]))
  const next = findings.map((f) => {
    const n = noteByKey.get(key(f))
    return n === undefined ? f : { ...f, note: n }
  })
  const out = { findings: next }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
} else {
  main()
}
