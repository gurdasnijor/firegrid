import { spawnSync } from "node:child_process"
import { error, log } from "node:console"
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import process from "node:process"
import { join } from "node:path"

const DOC_ROOTS = ["README.md", "docs", "features"]
const DOC_EXTENSIONS = new Set([".md", ".yaml"])
const DOC_CONFLICT_MARKER = /<<<<<<<|>>>>>>>|=======/
const DOC_TRAILING_WHITESPACE = /[ \t]$/

// firegrid-quality-gates.DOCS.3
const ARCH_EXCLUDE =
  "(^|/)(.*\\.test\\.(ts|tsx|mts)|__tests__|dist|build|coverage)(/|$)"
const EFFECT_DIAGNOSTICS_BASELINE = ".effect-diagnostics-baseline.json"
const EFFECT_DIAGNOSTIC_LINE =
  /^(?<file>[^()\n]+)\((?<line>\d+),(?<column>\d+)\): (?<severity>error|warning|message) effect\((?<code>[^)]+)\): (?<message>.*)$/

const archTargets = {
  workspace: {
    paths: ["packages"],
    output: "docs/dependency-graph.mmd",
    collapse: "^packages/[^/]+/src/[^/]+",
  },
  "workspace-detail": {
    paths: ["packages"],
    output: "docs/dependency-graph-detail.mmd",
  },
  client: {
    paths: ["packages/client/src"],
    output: "docs/dependency-graph-client.mmd",
    collapse: "^packages/client/src/[^/]+",
  },
  protocol: {
    paths: ["packages/protocol/src"],
    output: "docs/dependency-graph-protocol.mmd",
    collapse: "^packages/protocol/src/[^/]+",
  },
  runtime: {
    paths: ["packages/runtime/src"],
    output: "docs/dependency-graph-runtime.mmd",
    collapse: "^packages/runtime/src/[^/]+",
  },
  "runtime-detail": {
    paths: ["packages/runtime/src"],
    output: "docs/dependency-graph-runtime-detail.mmd",
  },
}

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
    ...options,
  })

  if (result.error !== undefined) {
    error(result.error.message)
    process.exit(1)
  }

  if (result.status !== 0) process.exit(result.status ?? 1)
}

const collectDocs = (path) => {
  const info = statSync(path)
  if (info.isFile()) {
    if ([...DOC_EXTENSIONS].some(extension => path.endsWith(extension))) {
      return [path]
    }
    return []
  }

  return readdirSync(path)
    .flatMap(entry => collectDocs(join(path, entry)))
}

const checkDocs = () => {
  let failed = false
  for (const file of DOC_ROOTS.flatMap(collectDocs)) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (DOC_TRAILING_WHITESPACE.test(line)) {
        error(`${file}:${String(index + 1)}: trailing whitespace`)
        failed = true
      }
      if (DOC_CONFLICT_MARKER.test(line)) {
        error(`${file}:${String(index + 1)}: merge conflict marker`)
        failed = true
      }
    }
  }
  if (failed) process.exit(1)
}

const checkSpecs = () => {
  run("ruby", [
    "-e",
    "require \"yaml\"; ARGV.each { |f| YAML.load_file(f); puts \"ok #{File.basename(f)}\" }",
    ...readdirSync("features", { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .flatMap(entry =>
        readdirSync(join("features", entry.name))
          .filter(file => file.endsWith(".feature.yaml"))
          .map(file => join("features", entry.name, file))
      ),
  ])
}

const emptyEffectCounts = () => ({ error: 0, warning: 0, message: 0 })

const effectDiagnosticSortKey = (entry) =>
  [
    entry.project,
    entry.file,
    String(entry.line),
    String(entry.column),
    entry.severity,
    entry.code,
    entry.message,
  ].join("\u0000")

const effectDiagnosticIdentityKey = (entry) =>
  [
    entry.project,
    entry.file,
    entry.severity,
    entry.code,
    entry.message,
  ].join("\u0000")

const summarizeEffectDiagnostics = (entries) =>
  entries.reduce((counts, entry) => {
    counts[entry.severity] += 1
    return counts
  }, emptyEffectCounts())

const effectDiagnosticEntryMap = (entries) => {
  const counts = new Map()
  for (const entry of entries) {
    const key = effectDiagnosticIdentityKey(entry)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

const parseEffectDiagnostics = (project, output) =>
  output
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = EFFECT_DIAGNOSTIC_LINE.exec(line)
      if (match === null) return []
      return [{
        project,
        file: match.groups.file,
        line: Number(match.groups.line),
        column: Number(match.groups.column),
        severity: match.groups.severity,
        code: match.groups.code,
        message: match.groups.message,
      }]
    })

const loadEffectDiagnosticsBaseline = () => {
  if (!existsSync(EFFECT_DIAGNOSTICS_BASELINE)) {
    error(`Missing ${EFFECT_DIAGNOSTICS_BASELINE}. Run pnpm run effect:diagnostics:baseline to capture the current baseline.`)
    process.exit(1)
  }
  const baseline = JSON.parse(readFileSync(EFFECT_DIAGNOSTICS_BASELINE, "utf8"))
  if (!Array.isArray(baseline.entries)) {
    error(`Invalid ${EFFECT_DIAGNOSTICS_BASELINE}: expected entries array.`)
    process.exit(1)
  }
  return baseline
}

const formatEffectCounts = (counts) =>
  `${counts.error} errors, ${counts.warning} warnings and ${counts.message} messages`

const compareEffectDiagnosticsToBaseline = (currentEntries) => {
  const baseline = loadEffectDiagnosticsBaseline()
  const baselineCounts = effectDiagnosticEntryMap(baseline.entries)
  const currentCounts = effectDiagnosticEntryMap(currentEntries)
  const additions = []

  for (const entry of currentEntries) {
    const key = effectDiagnosticIdentityKey(entry)
    const remaining = baselineCounts.get(key) ?? 0
    if (remaining > 0) {
      baselineCounts.set(key, remaining - 1)
      continue
    }
    const emitted = currentCounts.get(key) ?? 0
    if (emitted > 0) {
      additions.push(entry)
      currentCounts.set(key, emitted - 1)
    }
  }

  const currentSummary = summarizeEffectDiagnostics(currentEntries)
  const baselineSummary = baseline.counts ?? summarizeEffectDiagnostics(baseline.entries)
  if (additions.length === 0) {
    log(
      `Effect diagnostics baseline OK: current=${formatEffectCounts(currentSummary)}, baseline=${formatEffectCounts(baselineSummary)}`,
    )
    return
  }

  const additionSummary = summarizeEffectDiagnostics(additions)
  error(
    `Effect diagnostics regression: ${formatEffectCounts(additionSummary)} above baseline.`,
  )
  for (const entry of additions) {
    error(
      `${entry.file}:${String(entry.line)}:${String(entry.column)} ${entry.severity} effect(${entry.code}) ${entry.message}`,
    )
  }
  process.exit(1)
}

const writeEffectDiagnosticsBaseline = (entries) => {
  const sortedEntries = [...entries].sort((a, b) =>
    effectDiagnosticSortKey(a).localeCompare(effectDiagnosticSortKey(b)))
  const baseline = {
    version: 1,
    command: "pnpm run effect:diagnostics:baseline",
    counts: summarizeEffectDiagnostics(sortedEntries),
    entries: sortedEntries,
  }
  writeFileSync(
    EFFECT_DIAGNOSTICS_BASELINE,
    `${JSON.stringify(baseline, null, 2)}\n`,
  )
  log(
    `Wrote ${EFFECT_DIAGNOSTICS_BASELINE}: ${formatEffectCounts(baseline.counts)}`,
  )
}

const effectDiagnostics = (mode) => {
  const projects = [
    ...readdirSync("packages").map(name => join("packages", name, "tsconfig.json")),
  ].filter(path => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  })

  const entries = []
  for (const project of projects) {
    log(`== ${project} ==`)
    const result = spawnSync("effect-language-service", [
      "diagnostics",
      "--project",
      project,
      "--format",
      "text",
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    })
    if (result.error !== undefined) {
      error(result.error.message)
      process.exit(1)
    }
    if (result.stdout.length > 0) process.stdout.write(result.stdout)
    if (result.stderr.length > 0) process.stderr.write(result.stderr)
    entries.push(
      ...parseEffectDiagnostics(project, `${result.stdout}\n${result.stderr}`),
    )
  }

  if (mode === "--update-baseline") {
    writeEffectDiagnosticsBaseline(entries)
    return
  }

  compareEffectDiagnosticsToBaseline(entries)
}

const depcruise = (target) => {
  const config = archTargets[target]
  if (config === undefined) {
    error(`Unknown architecture target: ${target}`)
    process.exit(1)
  }

  const args = [
    "exec",
    "depcruise",
    "--config",
    ".dependency-cruiser.cjs",
    "--exclude",
    ARCH_EXCLUDE,
    ...config.paths,
    "--output-type",
    "mermaid",
  ]
  if (config.collapse !== undefined) {
    args.push("--collapse", config.collapse)
  }

  const result = spawnSync("pnpm", args, {
    encoding: "utf8",
    env: process.env,
  })
  if (result.error !== undefined) {
    error(result.error.message)
    process.exit(1)
  }
  if (result.stderr.length > 0) process.stderr.write(result.stderr)
  if (result.status !== 0) process.exit(result.status ?? 1)
  writeFileSync(config.output, result.stdout)
}

const archDeps = (target) => {
  if (target === "all") {
    for (const name of ["workspace", "client", "protocol", "runtime"]) {
      depcruise(name)
    }
    return
  }
  if (target === "detail") {
    for (const name of ["workspace-detail", "runtime-detail"]) {
      depcruise(name)
    }
    return
  }
  depcruise(target)
}

const [group, command, target] = process.argv.slice(2)

if (group === "check" && command === "specs") checkSpecs()
else if (group === "check" && command === "docs") checkDocs()
else if (group === "effect" && command === "diagnostics") effectDiagnostics(target)
else if (group === "arch" && command === "deps" && target !== undefined) {
  archDeps(target)
} else {
  error(`Unknown tooling command: ${process.argv.slice(2).join(" ")}`)
  process.exit(1)
}
