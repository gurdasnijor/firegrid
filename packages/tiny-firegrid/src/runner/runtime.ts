import {
  FiregridConfig,
  FiregridStandaloneLive,
} from "@firegrid/client-sdk/firegrid"
import { Console, Config, Data, Duration, Effect, Layer, Option } from "effect"
// Accepted bin-only local simulation escape hatch.
// eslint-disable-next-line no-restricted-imports
import { DurableStreamTestServer } from "@durable-streams/server"
import { mkdirSync } from "node:fs"
import { stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type {
  TinyFiregridHostEnv,
  TinyFiregridSimulation,
} from "../types.ts"
import { annotateSide } from "./side.ts"
import { TelemetryLive, type TelemetryDestination } from "./telemetry.ts"

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

// Chronological-first format so `ls .simulate/runs/` reads newest-last by
// default and tab-completion of "today's runs" actually narrows. Legacy
// runner used the same shape; we keep it for consistency.
const newRunId = (simulationId: string): string =>
  `${new Date().toISOString().replace(/[:.]/g, "-")}__${sanitizeSegment(simulationId)}`

// Package-relative .simulate/ root. Resolved off this module's URL so it
// stays correct regardless of cwd (the script may be invoked from anywhere
// in the monorepo via `pnpm --filter`).
const simulateRoot = path.resolve(
  fileURLToPath(new URL("../../.simulate/", import.meta.url)),
)
const runsRoot = path.join(simulateRoot, "runs")
const latestPath = path.join(simulateRoot, "latest.json")

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

interface RunOptions {
  readonly timeoutMs: number
  // When true, also emit each completed span to stdout via the OTel
  // ConsoleSpanExporter. Off by default — the file destination is the
  // primary artifact; console is an opt-in debugging aid that's noisy
  // enough to drown the actual signal during a real run.
  readonly console: boolean
}

// Only update the latest-pointer if the run produced at least one span.
// Writing eagerly at run start meant an interrupted / fast-failing run
// would clobber `latest.json` with a pointer to an empty runDir, and the
// next `simulate show` (no arg) would TraceFileMissing on the stale
// pointer. Now this runs as a finalizer after the simulation block — if
// the trace file is empty or missing, the prior valid pointer is
// preserved.
const maybeWriteLatest = (
  runId: string,
  simulationId: string,
  runDir: string,
  tracePath: string,
) =>
  Effect.promise(async () => {
    const size = await stat(tracePath).then(s => s.size, () => 0)
    if (size === 0) return
    await writeFile(
      latestPath,
      JSON.stringify({ runId, simulationId, runDir }, null, 2) + "\n",
      "utf8",
    )
  })

export const runSimulation = (
  simulation: TinyFiregridSimulation<unknown>,
  options: RunOptions,
) =>
  Effect.gen(function*() {
    const baseUrl = yield* durableStreamsBaseUrl
    const namespace = yield* NamespaceConfig
    const runId = newRunId(simulation.id)
    const runDir = path.join(runsRoot, runId)
    mkdirSync(runDir, { recursive: true })

    const tracePath = path.join(runDir, "trace.jsonl")
    const destination: TelemetryDestination = options.console
      ? { _tag: "console" }
      : { _tag: "file", filePath: tracePath }

    const telemetry = TelemetryLive(simulation, runId, {
      namespace,
      durableStreamsBaseUrl: baseUrl,
      destination,
    })

    yield* Console.log(`run: ${runId}`)
    yield* Console.log(`dir: ${runDir}`)
    if (destination._tag === "file") {
      yield* Console.log(`trace: ${destination.filePath}`)
    }

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
      // Conditional finalizer — runs on success, fail, and interrupt.
      // Only writes latest.json if at least one span actually flushed to
      // the trace file.
      Effect.ensuring(
        maybeWriteLatest(runId, simulation.id, runDir, tracePath).pipe(
          Effect.ignore,
        ),
      ),
    )
  }).pipe(Effect.scoped)
