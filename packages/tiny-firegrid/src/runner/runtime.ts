import {
  FiregridConfig,
  FiregridStandaloneLive,
} from "@firegrid/client-sdk/firegrid"
import {
  Console,
  Config,
  Data,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Ref,
} from "effect"
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
import { HeartbeatProcessor } from "./heartbeat-processor.ts"
import { annotateSide } from "./side.ts"
import { TelemetryLive, type TelemetryDestination } from "./telemetry.ts"

const defaultNamespace = "tiny-firegrid"

const NamespaceConfig = Config.string("FIREGRID_RUNTIME_NAMESPACE").pipe(
  Config.withDefault(defaultNamespace),
)
const DurableStreamsBaseUrlConfig = Config.string("DURABLE_STREAMS_BASE_URL").pipe(
  Config.option,
)

interface LatestPointerWriteFailed {
  readonly _tag: "LatestPointerWriteFailed"
  readonly cause: unknown
}

const latestPointerWriteFailed = (
  cause: unknown,
): LatestPointerWriteFailed => ({
  _tag: "LatestPointerWriteFailed",
  cause,
})

type SimulationOutcome =
  | { readonly _tag: "DriverCompleted" }
  | { readonly _tag: "StopSignaled" }
  | { readonly _tag: "TimedOut" }

const SimulationOutcome = Data.taggedEnum<SimulationOutcome>()

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
  // tf-ewo: --watch flag opts the heartbeat processor into per-event
  // emission (compact one-line-per-span to stderr) in addition to the
  // periodic digest. Default false — heartbeat-only is the right shape
  // for automated lanes / CI; per-event is for interactive debugging.
  readonly watch: boolean
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
  Effect.tryPromise({
    try: async () => {
      const size = await stat(tracePath).then(s => s.size, () => 0)
      if (size === 0) return false
      await writeFile(
        latestPath,
        JSON.stringify({ runId, simulationId, runDir }, null, 2) + "\n",
        "utf8",
      )
      return true
    },
    catch: latestPointerWriteFailed,
  }).pipe(
    Effect.tap(written =>
      written ? Effect.logDebug("latest pointer updated") : Effect.void,
    ),
    Effect.asVoid,
  )

export const runSimulation = (
  simulation: TinyFiregridSimulation<unknown>,
  options: RunOptions,
) =>
  Effect.gen(function*() {
    const baseUrl = yield* durableStreamsBaseUrl
    const namespace = yield* NamespaceConfig
    const stopSignal = yield* Deferred.make<void>()
    const sigintCount = yield* Ref.make(0)
    const runId = newRunId(simulation.id)
    const runDir = path.join(runsRoot, runId)
    mkdirSync(runDir, { recursive: true })

    const tracePath = path.join(runDir, "trace.jsonl")
    const destination: TelemetryDestination = options.console
      ? { _tag: "console" }
      : { _tag: "file", filePath: tracePath }

    // Heartbeat only fires when destination is file. OTLP + console
    // already have their own activity signal (remote backend / stdout
    // spam); heartbeat exists specifically to make the invisible-file
    // path observable. Constructed here (not inside telemetry.ts) so the
    // runner holds the reference and can drive the ticker fiber via
    // Effect.sleep — Effect ownership of scheduling, no JS timers.
    const heartbeat = destination._tag === "file"
      ? new HeartbeatProcessor({ perEvent: options.watch })
      : undefined
    const telemetry = TelemetryLive(simulation, runId, {
      namespace,
      durableStreamsBaseUrl: baseUrl,
      destination,
      heartbeat,
    })
    if (heartbeat !== undefined) {
      yield* Effect.gen(function*() {
        while (true) {
          yield* Effect.sleep(Duration.millis(heartbeat.intervalMs()))
          heartbeat.emitDigest()
        }
      }).pipe(Effect.forkScoped, Effect.asVoid)
    }
    const hostEnv: TinyFiregridHostEnv = {
      simulationId: simulation.id,
      runId,
      namespace,
      durableStreamsBaseUrl: baseUrl,
      processEnv: globalThis.process.env,
      stopSignal: {
        complete: Deferred.complete(stopSignal, Effect.void).pipe(
          Effect.asVoid,
        ),
      },
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const onSigint = Ref.updateAndGet(sigintCount, n => n + 1).pipe(
          Effect.flatMap(count =>
            count === 1
              ? Deferred.complete(stopSignal, Effect.void).pipe(
                Effect.asVoid,
              )
              : Effect.sync(() => globalThis.process.exit(130)),
          ),
        )
        const handler = () => {
          Effect.runFork(onSigint)
        }
        globalThis.process.on("SIGINT", handler)
        return handler
      }),
      handler => Effect.sync(() => globalThis.process.off("SIGINT", handler)),
    )

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

      yield* Layer.launch(simulation.host(hostEnv)).pipe(
        annotateSide("host"),
        Effect.forkScoped,
      )

      const outcome = yield* Effect.raceWith(
        simulation.driver.pipe(
          Effect.provide(firegridClientLayer(baseUrl, namespace)),
          annotateSide("driver"),
        ),
        Deferred.await(stopSignal),
        {
          onSelfDone: (_exit, stopFiber) =>
            Fiber.interrupt(stopFiber).pipe(
              Effect.as(SimulationOutcome.DriverCompleted()),
            ),
          onOtherDone: (_exit, driverFiber) =>
            Fiber.interrupt(driverFiber).pipe(
              Effect.as(SimulationOutcome.StopSignaled()),
            ),
        },
      ).pipe(
        Effect.timeoutTo({
          duration: Duration.millis(options.timeoutMs),
          onTimeout: () => SimulationOutcome.TimedOut(),
          onSuccess: outcome => outcome,
        }),
      )

      yield* Effect.annotateCurrentSpan(
        "firegrid.simulation.outcome",
        outcome._tag,
      )
      yield* Effect.logInfo("simulation stopped").pipe(
        Effect.annotateLogs({
          runId,
          simulationId: simulation.id,
          namespace,
          baseUrl,
          outcome: outcome._tag,
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
