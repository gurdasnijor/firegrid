import { Console, Data, Effect } from "effect"
import { readFile, readdir, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const simulateRoot = path.resolve(
  fileURLToPath(new URL("../../.simulate/", import.meta.url)),
)
const runsRoot = path.join(simulateRoot, "runs")
const latestPath = path.join(simulateRoot, "latest.json")

class NoRunsFound extends Data.TaggedClass("NoRunsFound")<{
  readonly runsRoot: string
}> {}

class RunNotFound extends Data.TaggedClass("RunNotFound")<{
  readonly runId: string
  readonly runsRoot: string
}> {}

class TraceFileMissing extends Data.TaggedClass("TraceFileMissing")<{
  readonly runDir: string
}> {}

// Spans as written by the file exporter in runner/telemetry.ts. We keep
// the parse permissive — missing optional fields are tolerated — so a
// partially-written trace (run still in progress, crash mid-batch) still
// renders something useful.
interface SpanRecord {
  readonly name: string
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId?: string
  readonly kind: number
  readonly startTime: readonly [number, number]
  readonly endTime: readonly [number, number]
  readonly duration: readonly [number, number]
  readonly status: { readonly code: number; readonly message?: string }
  readonly attributes: Record<string, unknown>
  readonly events?: ReadonlyArray<{
    readonly name: string
    readonly time: readonly [number, number]
    readonly attributes?: Record<string, unknown>
  }>
  readonly resource: Record<string, unknown>
}

const startNs = (s: SpanRecord): number =>
  s.startTime[0] * 1e9 + s.startTime[1]

const durationMs = (s: SpanRecord): number =>
  s.duration[0] * 1000 + s.duration[1] / 1e6

// Span names embedded with IDs (the high-cardinality ones host-sdk emits
// today) are collapsed at the head so the tree stays readable. The id
// fragments survive in attributes; the viewer's job is to show
// *structure*, not every detail.
const collapseName = (name: string): string =>
  name
    .replace(/\bctx_ext_[A-Za-z0-9_-]+/g, "ctx_ext_…")
    .replace(/\binput_[A-Za-z0-9_-]+/g, "input_…")

const formatLine = (s: SpanRecord, depth: number): string => {
  const indent = "  ".repeat(depth)
  const ms = durationMs(s).toFixed(1)
  const sideAttr = s.attributes["firegrid.side"]
  const side = typeof sideAttr === "string" ? ` [${sideAttr}]` : ""
  const status =
    s.status.code === 2
      ? " ⚠"
      : s.status.code === 1
      ? ""
      : ""
  return `${indent}- ${collapseName(s.name)}${side}${status} (${ms}ms)`
}

const buildTree = (spans: ReadonlyArray<SpanRecord>): string => {
  // Mid-run / interrupted-run robustness: OTel exports a span only on
  // `end`, so a sim in flight will have thousands of completed
  // descendants whose parents (`firegrid.simulation.run`,
  // `firegrid.side.*`, workflow scopes) haven't ended yet and aren't on
  // disk. Treat any span whose `parentSpanId` is not present in this
  // file as a *visual* root so the tree still builds — otherwise the
  // user gets a blank tree against a 3000-span file and thinks the
  // viewer is broken.
  const spanIds = new Set(spans.map(s => s.spanId))
  const byParent = new Map<string | undefined, Array<SpanRecord>>()
  spans.forEach(span => {
    const parentKey =
      span.parentSpanId !== undefined && spanIds.has(span.parentSpanId)
        ? span.parentSpanId
        : undefined
    const arr = byParent.get(parentKey) ?? []
    arr.push(span)
    byParent.set(parentKey, arr)
  })
  byParent.forEach(arr => arr.sort((a, b) => startNs(a) - startNs(b)))
  const out: Array<string> = []
  const walk = (span: SpanRecord, depth: number): void => {
    out.push(formatLine(span, depth))
    const children = byParent.get(span.spanId) ?? []
    children.forEach(child => walk(child, depth + 1))
  }
  ;(byParent.get(undefined) ?? []).forEach(root => walk(root, 0))
  return out.join("\n")
}

const summary = (spans: ReadonlyArray<SpanRecord>): string => {
  const errored = spans.filter(s => s.status.code === 2).length
  const traceIds = new Set(spans.map(s => s.traceId)).size
  const sides = new Map<string, number>()
  spans.forEach(span => {
    const side = span.attributes["firegrid.side"]
    if (typeof side === "string") {
      sides.set(side, (sides.get(side) ?? 0) + 1)
    }
  })
  const sidesText = [...sides.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(" ")
  return [
    `spans: ${spans.length}`,
    `traces: ${traceIds}`,
    `errored: ${errored}`,
    sidesText.length > 0 ? `sides: ${sidesText}` : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join("  ")
}

const resolveRunDir = (runId: string | undefined) =>
  Effect.gen(function*() {
    if (runId !== undefined) {
      const candidate = path.join(runsRoot, runId)
      const exists = yield* Effect.promise(() =>
        stat(candidate).then(() => true, () => false),
      )
      if (!exists) {
        return yield* Effect.fail(new RunNotFound({ runId, runsRoot }))
      }
      return candidate
    }
    // No id: prefer the on-disk latest.json pointer; if missing, fall back
    // to the most-recent runs/ entry (chronological-prefix runIds make
    // sorting trivial).
    const latest = yield* Effect.promise(() =>
      readFile(latestPath, "utf8").then(
        text => JSON.parse(text) as { readonly runDir?: string },
        () => undefined,
      ),
    )
    // Follow latest.json only if its target actually has a trace.jsonl —
    // an interrupted/failed run can leave a populated latest pointing at
    // an empty runDir, and following that would TraceFileMissing for the
    // user. Fall through to the directory walk in that case.
    if (latest?.runDir !== undefined) {
      const hasTrace = yield* Effect.promise(() =>
        stat(path.join(latest.runDir!, "trace.jsonl")).then(() => true, () => false),
      )
      if (hasTrace) return latest.runDir
    }
    // Most-recent run that actually has a `trace.jsonl`. Skip legacy
    // folders (pre-#426 runner) without erroring — they're archival.
    const entries = yield* Effect.promise(() =>
      readdir(runsRoot, { withFileTypes: true }).then(
        e => e.filter(d => d.isDirectory()).map(d => d.name).sort(),
        () => [],
      ),
    )
    for (let i = entries.length - 1; i >= 0; i--) {
      const candidate = path.join(runsRoot, entries[i]!)
      const hasTrace = yield* Effect.promise(() =>
        stat(path.join(candidate, "trace.jsonl")).then(() => true, () => false),
      )
      if (hasTrace) return candidate
    }
    return yield* Effect.fail(new NoRunsFound({ runsRoot }))
  })

export const showRun = (runId: string | undefined) =>
  Effect.gen(function*() {
    const runDir = yield* resolveRunDir(runId)
    const tracePath = path.join(runDir, "trace.jsonl")
    const text = yield* Effect.promise(() =>
      readFile(tracePath, "utf8").catch(() => undefined),
    )
    if (text === undefined) {
      return yield* Effect.fail(new TraceFileMissing({ runDir }))
    }
    const spans = text
      .split("\n")
      .filter(line => line.length > 0)
      .map(line => JSON.parse(line) as SpanRecord)
    yield* Console.log(`run: ${path.basename(runDir)}`)
    yield* Console.log(`dir: ${runDir}`)
    yield* Console.log(summary(spans))
    yield* Console.log("")
    yield* Console.log(buildTree(spans))
  })

// A "run" is a folder that contains `trace.jsonl`. Legacy folders left by
// the pre-#426 runner (run.json + trace.md + duckdb/) are filtered out
// silently — they're on disk for archival inspection but `simulate show`
// can't read them. Filtering here keeps the listing honest.
const hasTraceJsonl = (dir: string): Promise<boolean> =>
  stat(path.join(runsRoot, dir, "trace.jsonl")).then(() => true, () => false)

export const listRuns = Effect.gen(function*() {
  const entries = yield* Effect.promise(() =>
    readdir(runsRoot, { withFileTypes: true }).catch(() => []),
  )
  const candidates = entries
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort()
  const dirs = yield* Effect.promise(async () => {
    const checks = await Promise.all(
      candidates.map(async dir => ({ dir, ok: await hasTraceJsonl(dir) })),
    )
    return checks.filter(c => c.ok).map(c => c.dir)
  })
  if (dirs.length === 0) {
    yield* Console.log(`(no runs in ${runsRoot})`)
    return
  }
  yield* Effect.forEach(dirs, dir => Console.log(dir), { discard: true })
})
