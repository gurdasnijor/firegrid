import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import * as Otlp from "@effect/opentelemetry/Otlp"
import { NodeHttpClient } from "@effect/platform-node"
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base"
import type { HeartbeatProcessor } from "./heartbeat-processor.ts"
import { execSync } from "node:child_process"
import { createWriteStream, readFileSync, type WriteStream } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Config, Effect, Layer, Option } from "effect"
import type { TinyFiregridSimulation } from "../types.ts"

// Run-provenance attributes (Item E of the §6 observability batch).
// Resolved once at module load — they identify the binary that produced the
// trace, independent of the run. Failures are silently degraded to undefined:
// a non-git checkout or a sandboxed environment is a normal condition, not
// an error, and the trace stays useful without the attributes.
const safeExecSync = (cmd: string): string | undefined => {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim()
  } catch {
    return undefined
  }
}

const pkgVersion = (): string | undefined => {
  try {
    const pkgPath = path.resolve(
      fileURLToPath(new URL("../../package.json", import.meta.url)),
    )
    const json = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }
    return json.version
  } catch {
    return undefined
  }
}

const provenanceAttributes: Record<string, string> = (() => {
  const commit = safeExecSync("git rev-parse HEAD")
  const branch = safeExecSync("git rev-parse --abbrev-ref HEAD")
  const version = pkgVersion()
  const entries: Array<readonly [string, string]> = []
  if (commit !== undefined) entries.push(["firegrid.git.commit", commit])
  if (branch !== undefined && branch !== "HEAD") entries.push(["firegrid.git.branch", branch])
  if (version !== undefined) entries.push(["firegrid.tiny_firegrid.version", version])
  return Object.fromEntries(entries)
})()

const OtlpEndpointConfig = Config.string("OTEL_EXPORTER_OTLP_ENDPOINT").pipe(
  Config.option,
)
const OtlpHeadersConfig = Config.hashMap(
  Config.string(),
  "OTEL_EXPORTER_OTLP_HEADERS",
).pipe(Config.option)

const resource = (
  simulation: TinyFiregridSimulation<unknown>,
  runId: string,
  options: {
    readonly namespace: string
    readonly durableStreamsBaseUrl: string
  },
) => ({
  serviceName: "tiny-firegrid",
  attributes: {
    "firegrid.simulation.id": simulation.id,
    "firegrid.run.id": runId,
    "firegrid.namespace": options.namespace,
    "firegrid.durable_streams.base_url": options.durableStreamsBaseUrl,
    "firegrid.process.role": "tiny-firegrid",
    ...provenanceAttributes,
  },
})

// `firegrid.side` carries the value we want to filter on more than the
// hyphen-named OTel `service.namespace` does, so we leave it as a span
// attribute (propagated via `Effect.annotateSpans` in runner/side.ts).

// Resource attributes are flat key/value; nothing fancy here.
//
// One JSON object per span, newline-delimited. Each line is a self-contained
// record — the viewer doesn't need any envelope. Matches what
// `ConsoleSpanExporter` would print, minus the multi-paragraph
// `util.inspect` shape that made console output unusable.
const spanToJsonLine = (span: ReadableSpan): string => {
  const ctx = span.spanContext()
  const record = {
    name: span.name,
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    parentSpanId: span.parentSpanContext?.spanId,
    kind: span.kind,
    startTime: span.startTime,
    endTime: span.endTime,
    duration: span.duration,
    status: span.status,
    attributes: span.attributes,
    events: span.events,
    links: span.links,
    resource: span.resource.attributes,
  }
  return JSON.stringify(record) + "\n"
}

// Minimal `SpanExporter` that appends one JSON-line per span to a file.
// Wrapped in `BatchSpanProcessor` (not `SimpleSpanProcessor`) so writes
// coalesce — a run can emit thousands of spans and we don't want a syscall
// per span on the hot path.
class FileSpanExporter implements SpanExporter {
  private readonly stream: WriteStream
  private closed = false
  constructor(filePath: string) {
    this.stream = createWriteStream(filePath, { flags: "a" })
  }
  export(
    spans: ReadableSpan[],
    resultCallback: (result: { code: number; error?: Error }) => void,
  ): void {
    if (this.closed) {
      resultCallback({ code: 1, error: new Error("exporter closed") })
      return
    }
    try {
      spans.forEach(span => this.stream.write(spanToJsonLine(span)))
      resultCallback({ code: 0 })
    } catch (e) {
      resultCallback({ code: 1, error: e as Error })
    }
  }
  shutdown(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.closed = true
    return new Promise(resolve => this.stream.end(() => resolve()))
  }
  forceFlush(): Promise<void> {
    return Promise.resolve()
  }
}

export type TelemetryDestination =
  | { readonly _tag: "file"; readonly filePath: string }
  | { readonly _tag: "console" }

const fileTelemetryLive = (
  simulation: TinyFiregridSimulation<unknown>,
  runId: string,
  options: {
    readonly namespace: string
    readonly durableStreamsBaseUrl: string
    readonly filePath: string
    readonly heartbeat: HeartbeatProcessor | undefined
  },
) =>
  NodeSdk.layer(() => ({
    resource: resource(simulation, runId, options),
    // Multi-processor pattern: file exporter is the durable artifact;
    // heartbeat processor (constructed by the runner so it can drive the
    // ticker fiber) is the stderr liveness signal. Both fire on every
    // span end; only the file's batch processor buffers.
    spanProcessor: options.heartbeat !== undefined
      ? [
        new BatchSpanProcessor(new FileSpanExporter(options.filePath)),
        options.heartbeat,
      ]
      : new BatchSpanProcessor(new FileSpanExporter(options.filePath)),
  }))

const consoleTelemetryLive = (
  simulation: TinyFiregridSimulation<unknown>,
  runId: string,
  options: {
    readonly namespace: string
    readonly durableStreamsBaseUrl: string
  },
) =>
  NodeSdk.layer(() => ({
    resource: resource(simulation, runId, options),
    spanProcessor: new SimpleSpanProcessor(new ConsoleSpanExporter()),
  }))

// Routing precedence:
//   1. OTEL_EXPORTER_OTLP_ENDPOINT set → send to OTLP HTTP (production
//      observability backend; everything else is ignored).
//   2. destination._tag === "console" → ConsoleSpanExporter (opt-in via
//      --console; noisy, multi-paragraph util.inspect output, but
//      occasionally useful when there's no good place to write a file).
//   3. default → file destination — one JSON line per span at filePath.
export const TelemetryLive = (
  simulation: TinyFiregridSimulation<unknown>,
  runId: string,
  options: {
    readonly namespace: string
    readonly durableStreamsBaseUrl: string
    readonly destination: TelemetryDestination
    readonly heartbeat: HeartbeatProcessor | undefined
  },
): Layer.Layer<never, unknown> =>
  Layer.unwrapEffect(
    Effect.gen(function*() {
      const endpoint = yield* OtlpEndpointConfig
      if (Option.isSome(endpoint)) {
        const headers = yield* OtlpHeadersConfig
        return Otlp.layerJson({
          baseUrl: endpoint.value,
          resource: resource(simulation, runId, options),
          headers: Option.getOrUndefined(headers),
        }).pipe(
          Layer.provide(NodeHttpClient.layer),
        )
      }
      if (options.destination._tag === "console") {
        return consoleTelemetryLive(simulation, runId, options)
      }
      return fileTelemetryLive(simulation, runId, {
        ...options,
        filePath: options.destination.filePath,
      })
    }),
  )
