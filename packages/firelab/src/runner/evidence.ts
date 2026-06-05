/**
 * `firelab evidence <experiment> [run-id]` — the PR trace-evidence generator.
 * Re-judges a stored run with the experiment's coverage spec, then — if the spec
 * is feature-bound — derives the acai feature's ACIDs and renders the
 * requirement → ACID → forge-proof-span coverage table that `task-exit` posts to
 * the PR. Exit code gates on the feature being fully covered (the done-bar);
 * mutation-run + trace-tree are folded in by later increments.
 */
import { FileSystem, Path } from "@effect/platform"
import { Console, Effect, Option } from "effect"
import { analyzeCoverage, printSummary } from "./coverage.ts"
import { checkFeatureCoverage, parseFeature } from "./feature-coverage.ts"
import { selectedExperiment } from "./list.ts"
import { readTraceSpans, runsRoot } from "./trace.ts"

// features/ lives at the repo root: runner → src → firelab → packages → root.
const featuresRootUrl = new URL("../../../../features/", import.meta.url)

// Recursive walk for *.feature.yaml (features are subfoldered by product/group).
const findFeatureFiles = (
  dir: string,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []))
    const nested = yield* Effect.forEach(names, (name) =>
      Effect.gen(function*() {
        const full = path.join(dir, name)
        const info = yield* fs.stat(full).pipe(Effect.orElseSucceed(() => undefined))
        if (info?.type === "Directory") return yield* findFeatureFiles(full)
        return name.endsWith(".feature.yaml") ? [full] : []
      }))
    return nested.flat()
  })

// Resolve a feature by its acai name (ACIDs key off feature.name, not path).
const loadFeatureByName = (featureName: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* path.fromFileUrl(featuresRootUrl)
    const files = yield* findFeatureFiles(root)
    const parsed = yield* Effect.forEach(files, (f) =>
      fs.readFileString(f).pipe(
        Effect.map((t) => parseFeature(t)),
        Effect.orElseSucceed(() => ({ name: "", requirements: [] })),
      ))
    return Option.fromNullable(parsed.find((p) => p.name === featureName))
  })

// Newest run dir for a specific experiment (timestamp-prefixed → lexical sort).
const latestRunDirForExperiment = (experimentId: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* runsRoot
    const names = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []))
    const match = [...names].filter((n) => n.endsWith(`__${experimentId}`)).sort().at(-1)
    return Option.fromNullable(match === undefined ? undefined : path.join(root, match))
  })

export const showEvidence = (experimentId: string, runId: string | undefined) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const root = yield* runsRoot
    const experiment = yield* selectedExperiment(experimentId)
    const spec = experiment.coverage
    if (spec === undefined) {
      yield* Console.error(`experiment "${experimentId}" has no coverage spec; no evidence to render`)
      yield* Effect.sync(() => { process.exitCode = 1 })
      return
    }
    const runDirOpt = runId === undefined
      ? yield* latestRunDirForExperiment(experimentId)
      : Option.some(path.join(root, runId))
    if (Option.isNone(runDirOpt)) {
      yield* Console.error(`no stored run for "${experimentId}" — run it first (firelab run ${experimentId})`)
      yield* Effect.sync(() => { process.exitCode = 1 })
      return
    }
    const runDir = runDirOpt.value
    const spans = yield* readTraceSpans(runDir)
    const report = analyzeCoverage(spec, spans)

    yield* Console.log(`# firelab evidence — ${experimentId}\n`)
    yield* printSummary(report)

    if (spec.feature === undefined) {
      yield* Console.log("\n(no `feature` bound to this experiment's coverage — verdict only, no ACID table.)")
      if (report.gatingFailing > 0) yield* Effect.sync(() => { process.exitCode = 1 })
      return
    }

    const featureOpt = yield* loadFeatureByName(spec.feature)
    if (Option.isNone(featureOpt)) {
      yield* Console.error(`\n✋ coverage names feature "${spec.feature}" but no features/**/*.feature.yaml has feature.name == "${spec.feature}".`)
      yield* Effect.sync(() => { process.exitCode = 1 })
      return
    }
    const check = checkFeatureCoverage(spec, report, featureOpt.value)

    yield* Console.log(`\n## Feature coverage — \`${check.feature}\`  (${check.rows.filter((r) => r.status === "covered").length}/${check.rows.length} ACIDs)\n`)
    yield* Console.log("| ACID | status | gate → span | requirement |")
    yield* Console.log("|---|---|---|---|")
    yield* Effect.forEach(check.rows, (r) => {
      const mark = r.status === "covered" ? "✓" : r.status === "uncovered" ? "—" : r.status === "vacuous" ? "⚠" : "✗"
      const gate = r.gateId === undefined ? "" : `\`${r.gateId}\`${r.span === undefined ? "" : ` → \`${r.span}\``}`
      return Console.log(`| \`${r.acid}\` | ${mark} ${r.status} | ${gate} | ${r.text} |`)
    })
    if (check.duplicateAcids.length > 0) {
      yield* Console.log(`\n✗ ACIDs cited by more than one gate (breaks 1:1): ${check.duplicateAcids.join(", ")}`)
    }
    if (check.danglingGateAcids.length > 0) {
      yield* Console.log(`✗ gate ACIDs not in the feature: ${check.danglingGateAcids.join(", ")}`)
    }
    yield* Console.log(`\nfeature-fully-covered: ${check.fullyCovered}` +
      (report.gatingFailing > 0 ? `  (⚠ ${report.gatingFailing} gating claim(s) also failing)` : ""))
    // The done-bar is BOTH: every ACID covered 1:1 AND no gating claim failing —
    // an extra safety/non-ACID gate that fails or is vacuous must still block.
    if (!check.fullyCovered || report.gatingFailing > 0) {
      yield* Effect.sync(() => { process.exitCode = 1 })
    }
  })
