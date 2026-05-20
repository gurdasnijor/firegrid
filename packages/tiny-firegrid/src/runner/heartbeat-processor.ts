// tf-ewo: runner heartbeat as an OTel SpanProcessor + Effect-driven ticker.
//
// Why a SpanProcessor (not a file tail-reader): same code-complexity as
// the tail-reader design but with real-time event accuracy — onEnd fires
// the moment a span finishes, so the "idle Xs, last=foo" diagnostic
// reflects actual elapsed time, not file-poll resolution. Composes with
// the FileSpanExporter via OTel's multi-processor pattern; both processors
// fire on every span end.
//
// Why an external Effect ticker (not setTimeout inside the processor):
// Effect ownership of scheduling — `local/no-production-js-timers` rejects
// raw setTimeout; Effect.sleep + forkScoped composes with the runner's
// scope so the heartbeat dies cleanly with the simulation. The processor
// itself stays a pure accumulator-of-state with `emitDigest()` exposed for
// the ticker to call.
//
// Output volume is bounded: a digest line every ~2-10s by default
// (adaptive backoff). `--watch` opts into per-event emission via the same
// processor.

import type {
  ReadableSpan,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base"

interface HeartbeatOptions {
  /**
   * Minimum interval between digest lines (milliseconds). Heartbeat starts
   * at this interval; backs off up to `maxIntervalMs` on consecutive idle
   * ticks; resets to the floor on activity.
   */
  readonly minIntervalMs?: number
  /**
   * Maximum interval (milliseconds) the adaptive backoff will climb to.
   */
  readonly maxIntervalMs?: number
  /**
   * If true, emit a compact one-line summary per span (in addition to the
   * periodic digest). Useful for `--watch`-style interactive debugging.
   */
  readonly perEvent?: boolean
  /**
   * Stream to write heartbeat output to. Defaults to `process.stderr`.
   */
  readonly out?: NodeJS.WritableStream
}

const DEFAULT_MIN_INTERVAL_MS = 2_000
const DEFAULT_MAX_INTERVAL_MS = 10_000

const pad2 = (n: number): string => n.toString().padStart(2, "0")
const formatElapsed = (ms: number): string => {
  const totalSec = Math.floor(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${pad2(min)}:${pad2(sec)}`
}

const formatSides = (sides: Map<string, number>): string => {
  if (sides.size === 0) return "{}"
  return "{" + [...sides.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([key, value]) => `${key}=${value}`)
    .join(",") + "}"
}

export class HeartbeatProcessor implements SpanProcessor {
  // Accumulated counters since process start.
  private spans = 0
  private sides = new Map<string, number>()

  // Delta tracking since the last digest emission.
  private spansSinceLastDigest = 0

  // Last-activity tracking for the idle marker.
  private lastSpanName: string | undefined
  private lastSpanEndMs = Date.now()

  // Wall-clock anchor for the elapsed timestamp in the digest line.
  private readonly startMs = Date.now()

  // Adaptive interval state. Read by the external ticker; updated on each
  // digest emission based on whether activity arrived this tick.
  private currentIntervalMs: number
  private stopped = false

  private readonly minIntervalMs: number
  private readonly maxIntervalMs: number
  private readonly perEvent: boolean
  private readonly out: NodeJS.WritableStream

  constructor(options: HeartbeatOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
    this.maxIntervalMs = options.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS
    this.perEvent = options.perEvent ?? false
    this.out = options.out ?? process.stderr
    this.currentIntervalMs = this.minIntervalMs
  }

  onStart(): void {
    // No-op — heartbeat reports on span END, not start, so the count
    // matches the file exporter's view.
  }

  onEnd(span: ReadableSpan): void {
    if (this.stopped) return
    this.spans++
    this.spansSinceLastDigest++
    this.lastSpanName = span.name
    this.lastSpanEndMs = Date.now()
    const sideAttr = span.attributes["firegrid.side"]
    if (typeof sideAttr === "string") {
      this.sides.set(sideAttr, (this.sides.get(sideAttr) ?? 0) + 1)
    }
    if (this.perEvent) {
      this.writeEventLine(span)
    }
  }

  async forceFlush(): Promise<void> {
    // Heartbeat is not a buffering exporter — events are tee'd live via
    // onEnd and the digest is timer-driven. forceFlush is a no-op.
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    // Single final emit so the operator sees the closing state.
    this.emitDigest()
  }

  /**
   * Returns the current adaptive interval. Called by the external ticker
   * to know how long to sleep before the next digest.
   */
  intervalMs(): number {
    return this.currentIntervalMs
  }

  /**
   * Emit a digest line and update the adaptive interval. Called by the
   * external Effect ticker on each tick.
   */
  emitDigest(): void {
    if (this.stopped) return
    const elapsedMs = Date.now() - this.startMs
    const idleMs = Date.now() - this.lastSpanEndMs
    const idleSec = Math.floor(idleMs / 1000)
    // Mark "idle" when no spans arrived this tick AND the gap since the
    // last span is meaningful. Threshold = 2× current interval so the
    // warning lags activity changes appropriately.
    const idleThresholdMs = this.currentIntervalMs * 2
    const idleMarker = (this.spansSinceLastDigest === 0 && idleMs >= idleThresholdMs)
      ? `  ⚠ idle ${idleSec}s`
      : ""
    const lastInfo = this.lastSpanName !== undefined
      ? `last=${this.lastSpanName} +${(idleMs / 1000).toFixed(1)}s`
      : "last=<none>"
    this.out.write(
      `[${formatElapsed(elapsedMs)}] spans=${this.spans} (+${this.spansSinceLastDigest})  sides=${formatSides(this.sides)}  ${lastInfo}${idleMarker}\n`,
    )
    // Adaptive backoff: reset to floor on activity, double on idle (cap
    // at max). Mirrors exponential-backoff but applied to *observation*
    // interval, not retry interval.
    if (this.spansSinceLastDigest > 0) {
      this.currentIntervalMs = this.minIntervalMs
    } else {
      this.currentIntervalMs = Math.min(
        this.currentIntervalMs * 2,
        this.maxIntervalMs,
      )
    }
    this.spansSinceLastDigest = 0
  }

  /**
   * `--watch` per-event line. Compact format mirrors the digest's
   * vocabulary (elapsed-since-start prefix + side tag) so operators don't
   * have to learn two formats.
   */
  private writeEventLine(span: ReadableSpan): void {
    const elapsedMs = Date.now() - this.startMs
    const side = (span.attributes["firegrid.side"] as string | undefined) ?? "-"
    const durationMs = (span.duration[0] * 1000) + (span.duration[1] / 1e6)
    this.out.write(
      `[${formatElapsed(elapsedMs)}] [${side}] ${span.name} (${durationMs.toFixed(1)}ms)\n`,
    )
  }
}
