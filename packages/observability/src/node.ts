import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import * as Otlp from "@effect/opentelemetry/Otlp"
import { NodeHttpClient } from "@effect/platform-node"
import {
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

const OtlpEndpointConfig = Config.string("OTEL_EXPORTER_OTLP_ENDPOINT").pipe(
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
  },
): FiregridOtelDestination | undefined => {
  // firegrid-observability.HOST_PROCESS_EXPORTERS.3
  const envName = options.envName ?? "FIREGRID_OTEL_FILE"
  const filePath = nonEmpty(options.filePath) ?? nonEmpty(options.env?.[envName])
  if (filePath === undefined) return undefined
  return { _tag: "file", filePath }
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

const fileTelemetryLive = (
  options: FiregridOtelLayerOptions & {
    readonly destination: { readonly _tag: "file"; readonly filePath: string }
  },
) =>
  // firegrid-observability.HOST_PROCESS_EXPORTERS.3
  // tf-r1gz: a file-backed debug exporter must be lossless for long-running
  // ACP processes that may be killed abruptly (e.g. Zed disconnecting the
  // agent). BatchSpanProcessor only drains on its 5s/512-span timer or on a
  // clean shutdown, so a short session or an abrupt SIGKILL within a batch
  // window dropped recent spans. SimpleSpanProcessor writes each ended span
  // immediately — matching the console destination — so the JSONL artifact
  // is always current without needing the process to exit.
  NodeSdk.layer(() => ({
    resource: options.resource,
    spanProcessor: [
      new SimpleSpanProcessor(new JsonlFileSpanExporter(options.destination.filePath)),
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
        case "file":
          return fileTelemetryLive({
            ...options,
            destination: options.destination,
          })
      }
    }),
  )
