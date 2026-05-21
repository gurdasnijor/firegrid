import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import * as Otlp from "@effect/opentelemetry/Otlp"
import { NodeHttpClient } from "@effect/platform-node"
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { Config, Effect, Layer, Option } from "effect"
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs"
import path from "node:path"

export type {
  ReadableSpan,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base"

export type FiregridOtelAttributeValue =
  | string
  | number
  | boolean
  | Array<string>
  | Array<number>
  | Array<boolean>

export interface FiregridOtelResource {
  readonly serviceName: string
  readonly serviceVersion?: string
  readonly attributes?: Record<string, FiregridOtelAttributeValue>
}

export type FiregridOtelDestination =
  | { readonly _tag: "file"; readonly filePath: string }
  | { readonly _tag: "console" }

export interface FiregridOtelLayerOptions {
  readonly resource: FiregridOtelResource
  readonly destination: FiregridOtelDestination
  readonly spanProcessors?: ReadonlyArray<SpanProcessor>
}

export const FIREGRID_OTEL_OTLP_ENDPOINT_ENV = "OTEL_EXPORTER_OTLP_ENDPOINT"

const OtlpEndpointConfig = Config.string(FIREGRID_OTEL_OTLP_ENDPOINT_ENV).pipe(
  Config.option,
)
const OtlpHeadersConfig = Config.hashMap(
  Config.string(),
  "OTEL_EXPORTER_OTLP_HEADERS",
).pipe(Config.option)

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.length === 0 ? undefined : value

export const resolveFiregridOtelFileDestination = (
  options: {
    readonly filePath?: string
    readonly env?: NodeJS.ProcessEnv
    readonly envName?: string
    // tf-r1gz: base directory a RELATIVE filePath resolves against. Callers
    // pass the operator-supplied --cwd (the project root), so the trace lands
    // in the repo rather than wherever the host process was launched (e.g.
    // Zed's cwd). When omitted, the raw path is returned unchanged. Keeping
    // the resolution here (a pure function of its inputs) instead of reading
    // process.cwd() inline makes it unit-testable.
    readonly baseDir?: string
  },
): FiregridOtelDestination | undefined => {
  // firegrid-observability.HOST_PROCESS_EXPORTERS.3
  const envName = options.envName ?? "FIREGRID_OTEL_FILE"
  const filePath = nonEmpty(options.filePath) ?? nonEmpty(options.env?.[envName])
  if (filePath === undefined) return undefined
  const baseDir = nonEmpty(options.baseDir)
  return {
    _tag: "file",
    filePath: baseDir === undefined ? filePath : path.resolve(baseDir, filePath),
  }
}

// tf-r1gz: the exporter that will actually run. This mirrors the precedence in
// `FiregridOtelLive` (OTLP wins over the file/console destination when
// OTEL_EXPORTER_OTLP_ENDPOINT is set) and the fact that the OTel layer is only
// installed once a destination is resolved. Callers use it to announce what
// will actually happen — a file announcement must NOT print when spans really
// go to OTLP, which would recreate the "trace file never appears" confusion.
export type FiregridOtelActiveExporter =
  | { readonly _tag: "otlp"; readonly endpoint: string }
  | { readonly _tag: "file"; readonly filePath: string }
  | { readonly _tag: "console" }
  | { readonly _tag: "none" }

export const resolveFiregridOtelActiveExporter = (
  options: {
    readonly destination: FiregridOtelDestination | undefined
    readonly env?: NodeJS.ProcessEnv
  },
): FiregridOtelActiveExporter => {
  if (options.destination === undefined) return { _tag: "none" }
  const endpoint = nonEmpty(options.env?.[FIREGRID_OTEL_OTLP_ENDPOINT_ENV])
  if (endpoint !== undefined) return { _tag: "otlp", endpoint }
  return options.destination
}

export const spanToJsonLine = (span: ReadableSpan): string => {
  const context = span.spanContext()
  return JSON.stringify({
    name: span.name,
    traceId: context.traceId,
    spanId: context.spanId,
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
  }) + "\n"
}

export class JsonlFileSpanExporter implements SpanExporter {
  private readonly stream: WriteStream
  private closed = false

  constructor(filePath: string) {
    const resolvedPath = path.resolve(filePath)
    mkdirSync(path.dirname(resolvedPath), { recursive: true })
    this.stream = createWriteStream(resolvedPath, { flags: "a" })
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
    } catch (cause) {
      resultCallback({ code: 1, error: cause as Error })
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

export type FiregridOtelFlushMode = "immediate" | "batched"

// firegrid-observability.HOST_PROCESS_EXPORTERS.3
// tf-r1gz: the file flush strategy is a real tradeoff, so it is a knob with a
// safe default rather than a hardcode. `immediate` (SimpleSpanProcessor, the
// default — matching the console destination) writes each ended span as it
// completes, so a long-running ACP process populates the JSONL artifact
// continuously and an abrupt editor disconnect cannot discard a pending batch.
// `batched` (BatchSpanProcessor) restores 5s/512-span batching for high-span-
// rate non-interactive hosts that prefer throughput over per-span latency.
const FlushModeConfig: Config.Config<FiregridOtelFlushMode> = Config.literal(
  "immediate",
  "batched",
)("FIREGRID_OTEL_FILE_FLUSH").pipe(Config.withDefault("immediate"))

const fileSpanProcessor = (
  filePath: string,
  flushMode: FiregridOtelFlushMode,
): SpanProcessor => {
  const exporter = new JsonlFileSpanExporter(filePath)
  return flushMode === "batched"
    ? new BatchSpanProcessor(exporter)
    : new SimpleSpanProcessor(exporter)
}

const fileTelemetryLive = (
  options: FiregridOtelLayerOptions & {
    readonly destination: { readonly _tag: "file"; readonly filePath: string }
    readonly flushMode: FiregridOtelFlushMode
  },
) =>
  NodeSdk.layer(() => ({
    resource: options.resource,
    spanProcessor: [
      fileSpanProcessor(options.destination.filePath, options.flushMode),
      ...(options.spanProcessors ?? []),
    ],
  }))

const consoleTelemetryLive = (
  options: FiregridOtelLayerOptions & {
    readonly destination: { readonly _tag: "console" }
  },
) =>
  NodeSdk.layer(() => ({
    resource: options.resource,
    spanProcessor: [
      new SimpleSpanProcessor(new ConsoleSpanExporter()),
      ...(options.spanProcessors ?? []),
    ],
  }))

export const FiregridOtelLive = (
  options: FiregridOtelLayerOptions,
): Layer.Layer<never, unknown> =>
  // firegrid-observability.HOST_PROCESS_EXPORTERS.1
  // firegrid-observability.HOST_PROCESS_EXPORTERS.2
  Layer.unwrapEffect(
    Effect.gen(function*() {
      const endpoint = yield* OtlpEndpointConfig
      if (Option.isSome(endpoint)) {
        const headers = yield* OtlpHeadersConfig
        return Otlp.layerJson({
          baseUrl: endpoint.value,
          resource: options.resource,
          headers: Option.getOrUndefined(headers),
        }).pipe(
          Layer.provide(NodeHttpClient.layer),
        )
      }
      switch (options.destination._tag) {
        case "console":
          return consoleTelemetryLive({
            ...options,
            destination: options.destination,
          })
        case "file": {
          const flushMode = yield* FlushModeConfig
          return fileTelemetryLive({
            ...options,
            destination: options.destination,
            flushMode,
          })
        }
      }
    }),
  )
