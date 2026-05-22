import { Data, Effect } from "effect"
import { readFile, readdir, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const simulateRoot = path.resolve(
  fileURLToPath(new URL("../../.simulate/", import.meta.url)),
)
export const runsRoot = path.join(simulateRoot, "runs")
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

export interface SpanRecord {
  // tf-9ia9: the observability file exporter can emit phase:start records for
  // in-flight spans (opt-in via FIREGRID_OTEL_FILE_PHASES=start-end). Trace
  // readers here consume completed spans only, so start records are filtered
  // out in readTraceSpans. Absent on legacy/end-only traces.
  readonly phase?: "start" | "end"
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

export const nsFromHrTime = (time: readonly [number, number]): bigint =>
  BigInt(time[0]) * 1_000_000_000n + BigInt(time[1])

export const startNs = (span: SpanRecord): bigint =>
  nsFromHrTime(span.startTime)

export const endNs = (span: SpanRecord): bigint =>
  nsFromHrTime(span.endTime)

export const durationNs = (span: SpanRecord): bigint => {
  const fromField = nsFromHrTime(span.duration)
  return fromField >= 0n ? fromField : endNs(span) - startNs(span)
}

export const nsToMs = (ns: bigint): number =>
  Number(ns) / 1_000_000

export const compareNs = (a: bigint, b: bigint): number =>
  a < b ? -1 : a > b ? 1 : 0

export const isoFromNs = (ns: bigint): string =>
  new Date(Number(ns / 1_000_000n)).toISOString()

export const tracePathForRunDir = (runDir: string): string =>
  path.join(runDir, "trace.jsonl")

export const resolveRunDir = (runId: string | undefined) =>
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
    const latest = yield* Effect.promise(() =>
      readFile(latestPath, "utf8").then(
        text => JSON.parse(text) as { readonly runDir?: string },
        () => undefined,
      ),
    )
    if (latest?.runDir !== undefined) {
      const hasTrace = yield* Effect.promise(() =>
        stat(tracePathForRunDir(latest.runDir!)).then(() => true, () => false),
      )
      if (hasTrace) return latest.runDir
    }
    const entries = yield* Effect.promise(() =>
      readdir(runsRoot, { withFileTypes: true }).then(
        e => e.filter(d => d.isDirectory()).map(d => d.name).sort(),
        () => [],
      ),
    )
    for (let i = entries.length - 1; i >= 0; i--) {
      const candidate = path.join(runsRoot, entries[i]!)
      const hasTrace = yield* Effect.promise(() =>
        stat(tracePathForRunDir(candidate)).then(() => true, () => false),
      )
      if (hasTrace) return candidate
    }
    return yield* Effect.fail(new NoRunsFound({ runsRoot }))
  })

export const readTraceSpans = (runDir: string) =>
  Effect.gen(function*() {
    const tracePath = tracePathForRunDir(runDir)
    const text = yield* Effect.promise(() =>
      readFile(tracePath, "utf8").catch(() => undefined),
    )
    if (text === undefined) {
      return yield* Effect.fail(new TraceFileMissing({ runDir }))
    }
    return text
      .split("\n")
      .filter(line => line.length > 0)
      .map(line => JSON.parse(line) as SpanRecord)
      // tf-9ia9: drop in-flight span-START records; readers here report on
      // completed spans (durations, self-time). End-only/legacy traces have no
      // `phase` field and are kept.
      .filter(span => span.phase !== "start")
  })

export const hasTraceJsonl = (dir: string): Promise<boolean> =>
  stat(tracePathForRunDir(dir)).then(() => true, () => false)
