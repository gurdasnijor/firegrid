import {
  FiregridConfig,
  FiregridStandaloneLive,
} from "@firegrid/client-sdk/firegrid"
import { Config, Data, Duration, Effect, Layer, Option } from "effect"
// Accepted bin-only local simulation escape hatch.
// eslint-disable-next-line no-restricted-imports
import { DurableStreamTestServer } from "@durable-streams/server"
import type {
  TinyFiregridHostEnv,
  TinyFiregridSimulation,
} from "../types.ts"
import { annotateSide } from "./side.ts"
import { TelemetryLive } from "./telemetry.ts"

const defaultNamespace = "tiny-firegrid"

const NamespaceConfig = Config.string("FIREGRID_RUNTIME_NAMESPACE").pipe(
  Config.withDefault(defaultNamespace),
)
const DurableStreamsBaseUrlConfig = Config.string("DURABLE_STREAMS_BASE_URL").pipe(
  Config.option,
)

class SimulationTimeout extends Data.TaggedClass("SimulationTimeout")<{
  readonly ms: number
}> {}

const durableStreamsBaseUrl = Effect.gen(function*() {
  const configured = yield* DurableStreamsBaseUrlConfig
  if (Option.isSome(configured)) {
    return configured.value
  }
  const server = yield* Effect.acquireRelease(
    Effect.promise(async () => {
      const server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
      const baseUrl = await server.start()
      return { server, baseUrl }
    }),
    ({ server }) => Effect.promise(() => server.stop()),
  )
  return server.baseUrl
})

const sanitizeSegment = (value: string): string =>
  value.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/-+/g, "-")

const newRunId = (simulationId: string): string =>
  sanitizeSegment(`${simulationId}-${new Date().toISOString().replace(/[:.]/g, "-")}`)

const firegridClientLayer = (
  durableStreamsBaseUrl: string,
  namespace: string,
) =>
  FiregridStandaloneLive.pipe(
    Layer.provide(
      Layer.succeed(FiregridConfig, {
        durableStreamsBaseUrl,
        namespace,
      }),
    ),
  )

export const runSimulation = (
  simulation: TinyFiregridSimulation<unknown>,
  options: { readonly timeoutMs: number },
) =>
  Effect.gen(function*() {
    const baseUrl = yield* durableStreamsBaseUrl
    const namespace = yield* NamespaceConfig
    const runId = newRunId(simulation.id)
    const telemetry = TelemetryLive(simulation, runId, {
      namespace,
      durableStreamsBaseUrl: baseUrl,
    })

    yield* Effect.gen(function*() {
      yield* Effect.logInfo("simulation starting").pipe(
        Effect.annotateLogs({
          runId,
          simulationId: simulation.id,
          namespace,
          baseUrl,
        }),
      )

      const hostEnv: TinyFiregridHostEnv = {
        simulationId: simulation.id,
        runId,
        namespace,
        durableStreamsBaseUrl: baseUrl,
        processEnv: globalThis.process.env,
      }

      yield* Layer.launch(simulation.host(hostEnv)).pipe(
        annotateSide("host"),
        Effect.forkScoped,
      )

      yield* simulation.driver.pipe(
        Effect.provide(firegridClientLayer(baseUrl, namespace)),
        annotateSide("driver"),
        Effect.timeoutFail({
          duration: Duration.millis(options.timeoutMs),
          onTimeout: () => new SimulationTimeout({ ms: options.timeoutMs }),
        }),
      )

      yield* Effect.logInfo("simulation completed").pipe(
        Effect.annotateLogs({
          runId,
          simulationId: simulation.id,
          namespace,
          baseUrl,
        }),
      )
    }).pipe(
      Effect.withSpan("firegrid.simulation.run", {
        attributes: {
          "firegrid.simulation.id": simulation.id,
          "firegrid.run.id": runId,
          "firegrid.namespace": namespace,
          "firegrid.durable_streams.base_url": baseUrl,
        },
      }),
      Effect.provide(telemetry),
    )
  }).pipe(Effect.scoped)
