import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import * as Otlp from "@effect/opentelemetry/Otlp"
import { NodeHttpClient } from "@effect/platform-node"
import { ConsoleSpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { Config, Effect, Layer, Option } from "effect"
import type { TinyFiregridSimulation } from "../types.ts"

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
  },
})

const ConsoleTelemetryLive = (
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

export const TelemetryLive = (
  simulation: TinyFiregridSimulation<unknown>,
  runId: string,
  options: {
    readonly namespace: string
    readonly durableStreamsBaseUrl: string
  },
): Layer.Layer<never, unknown> =>
  Layer.unwrapEffect(
    Effect.gen(function*() {
      const endpoint = yield* OtlpEndpointConfig
      if (Option.isNone(endpoint)) {
        return ConsoleTelemetryLive(simulation, runId, options)
      }
      const headers = yield* OtlpHeadersConfig
      return Otlp.layerJson({
        baseUrl: endpoint.value,
        resource: resource(simulation, runId, options),
        headers: Option.getOrUndefined(headers),
      }).pipe(
        Layer.provide(NodeHttpClient.layer),
      )
    }),
  )
