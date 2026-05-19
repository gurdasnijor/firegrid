import {
  FiregridConfig,
  FiregridStandaloneLive,
} from "@firegrid/client-sdk/firegrid"
// firegrid-observability.TINY_FIREGRID_SIMULATIONS.6
// Accepted bin-only local simulation escape hatch.
// eslint-disable-next-line no-restricted-imports
import { DurableStreamTestServer } from "@durable-streams/server"
import {
  localProcessSpawnEnvFromHostEnv,
} from "@firegrid/host-sdk"
import * as FileSystem from "@effect/platform/FileSystem"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { Data, Duration, Effect, Fiber, Layer, Queue, Stream } from "effect"
import { spawnSync } from "node:child_process"
import path from "node:path"
import {
  sanitizeTinyTracePathSegment,
  writeTinyFiregridTraceRun,
  type TinyTraceArtifactPaths,
} from "../simulations/trace-artifacts.ts"
import { runWithTraceRecorder } from "../simulations/trace-recorder.ts"
import {
  findTinyFiregridSimulation,
  loadTinyFiregridSimulations,
  tinyFiregridSimulationList,
} from "../simulations/registry.ts"
import type { TinyFiregridSimulation, TinyFiregridSimulationEnv } from "../simulations/types.ts"

// firegrid-observability.TINY_FIREGRID_SIMULATIONS.1
// firegrid-observability.TINY_FIREGRID_SIMULATIONS.2
// firegrid-observability.TINY_FIREGRID_SIMULATIONS.3
// firegrid-observability.TINY_FIREGRID_SIMULATIONS.4
// firegrid-observability.TINY_FIREGRID_SIMULATIONS.5
// firegrid-observability.TINY_FIREGRID_SIMULATIONS.6
// firegrid-observability.TINY_FIREGRID_SIMULATIONS.7
interface RunnerEnv {
  readonly runId: string
  readonly simulationId: string
  readonly namespace: string
  readonly simulateRoot: string
  readonly runDir: string
  readonly durableStreamsBaseUrl: string
  readonly durableStreamsManaged: boolean
  readonly timeout: Duration.Duration
  readonly tail: boolean
}

type RunStatus = "running" | "completed" | "failed"

interface RunManifest {
  readonly schemaVersion: 1
  readonly runId: string
  readonly simulationId: string
  readonly description: string
  readonly status: RunStatus
  readonly createdAt: string
  readonly updatedAt: string
  readonly namespace: string
  readonly durableStreamsBaseUrl: string
  readonly timeout: string
  readonly timeoutMs: number
  readonly runDir: string
  readonly summary?: Record<string, unknown>
  readonly localization?: ReadonlyArray<string>
  readonly error?: string
  readonly trace: {
    readonly markdown: string
    readonly json: string
    readonly liveSpansJsonl: string
    readonly otlpJsonl: string
    readonly duckdbSql: string
    readonly duckdb: string
  }
  readonly durableStreams: {
    readonly managed: boolean
  }
  readonly commands: {
    readonly show: string
    readonly tail: string
    readonly duckdb: string
    readonly summary: string
  }
}

const usage = [
  "tiny-firegrid simulate",
  "",
  "Commands:",
  "  simulate list                         # registered simulations",
  "  simulate runs                         # local evidence runs",
  "  simulate run [simulation-id] [--tail]  # create a run in .simulate/runs",
  "  simulate show [latest|run-id]          # print run metadata",
  "  simulate tail [latest|run-id]          # stream ended spans as JSONL",
  "  simulate attach [latest|run-id]        # alias for tail",
  "  simulate duckdb [latest|run-id]        # open DuckDB on an existing run",
  "  simulate query [latest|run-id] <sql>   # run SQL against an existing run",
  "",
  "Environment:",
  "  FIREGRID_DURABLE_STREAMS_URL or TINY_FIREGRID_DURABLE_STREAMS_URL",
  "  TINY_FIREGRID_NAMESPACE",
  "  TINY_FIREGRID_SIMULATE_DIR             # defaults to packages/tiny-firegrid/.simulate",
  "  TINY_FIREGRID_TIMEOUT                 # defaults to \"90 seconds\"",
  "  TINY_FIREGRID_RUN_ID",
].join("\n")

const nowIso = (): string => new Date().toISOString()

const nowStamp = (): string => nowIso().replace(/[:.]/g, "-")

const packageRoot = (): string => path.resolve(import.meta.dirname, "../..")

const simulateRoot = (): string =>
  path.resolve(
    globalThis.process.env.TINY_FIREGRID_SIMULATE_DIR ??
      path.join(packageRoot(), ".simulate"),
  )

const runsRoot = (): string => path.join(simulateRoot(), "runs")

const latestPath = (): string => path.join(simulateRoot(), "latest.json")

const runJsonPath = (runDir: string): string => path.join(runDir, "run.json")

const defaultSimulationTimeout = "90 seconds"

class SimulationRunTimeout extends Data.TaggedError("SimulationRunTimeout")<{
  readonly timeout: Duration.Duration
}> {
  override get message(): string {
    return `tiny-firegrid simulation timed out after ${Duration.format(this.timeout)}`
  }
}

const isSimulationRunTimeout = (error: unknown): error is SimulationRunTimeout =>
  error instanceof SimulationRunTimeout ||
  (typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "SimulationRunTimeout" &&
    "timeout" in error)

const simulationRunTimeoutDuration = (
  error: unknown,
  fallback: Duration.Duration,
): Duration.Duration | undefined => {
  if (isSimulationRunTimeout(error)) return error.timeout
  if (
    error instanceof Error &&
    error.message.startsWith("tiny-firegrid simulation timed out after ")
  ) {
    return fallback
  }
  return undefined
}

const runFileSystem = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)))

const ensureDirectory = (dir: string): Promise<void> =>
  runFileSystem(FileSystem.FileSystem.pipe(
    Effect.flatMap(fs => fs.makeDirectory(dir, { recursive: true })),
  ))

const writeFileString = (
  file: string,
  contents: string,
  options?: FileSystem.WriteFileStringOptions,
): Promise<void> =>
  runFileSystem(FileSystem.FileSystem.pipe(
    Effect.flatMap(fs => fs.writeFileString(file, contents, options)),
  ))

const readFileString = (file: string): Promise<string> =>
  runFileSystem(FileSystem.FileSystem.pipe(
    Effect.flatMap(fs => fs.readFileString(file)),
  ))

const pathExists = (file: string): Promise<boolean> =>
  runFileSystem(FileSystem.FileSystem.pipe(
    Effect.flatMap(fs => fs.exists(file)),
  ))

const readDirectory = (dir: string): Promise<ReadonlyArray<string>> =>
  runFileSystem(FileSystem.FileSystem.pipe(
    Effect.flatMap(fs => fs.readDirectory(dir)),
  ))

interface LiveWriter {
  readonly write: (event: Record<string, unknown>) => void
  readonly close: () => Promise<void>
}

type LiveEventItem =
  | { readonly _tag: "Event"; readonly event: Record<string, unknown> }
  | { readonly _tag: "End" }

const liveEventLine = (event: Record<string, unknown>): string =>
  `${JSON.stringify({ ts: nowIso(), ...event })}\n`

const makeLiveWriter = async (
  file: string,
  tail: boolean,
): Promise<LiveWriter> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const queue = yield* Queue.unbounded<LiveEventItem>()
      const fiber = yield* Stream.fromQueue(queue).pipe(
        Stream.takeUntil(item => item._tag === "End"),
        Stream.runForEach(item => {
          if (item._tag === "End") return Effect.void
          const line = liveEventLine(item.event)
          return fs.writeFileString(file, line, { flag: "a" }).pipe(
            Effect.zipRight(Effect.sync(() => {
              if (tail) globalThis.process.stdout.write(line)
            })),
          )
        }),
        Effect.forkDaemon,
      )
      return {
        write: (event: Record<string, unknown>) => {
          queue.unsafeOffer({ _tag: "Event", event })
        },
        close: () =>
          Effect.runPromise(
            Queue.offer(queue, { _tag: "End" }).pipe(
              Effect.zipRight(Fiber.join(fiber)),
            ),
          ),
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  )

const configuredDurableStreamsBaseUrl = (): string | undefined => {
  const value = globalThis.process.env.TINY_FIREGRID_DURABLE_STREAMS_URL ??
    globalThis.process.env.FIREGRID_DURABLE_STREAMS_URL
  if (value !== undefined && value.length > 0) return value
  return undefined
}

const simulationTimeout = (): Duration.Duration => {
  const input = globalThis.process.env.TINY_FIREGRID_TIMEOUT ??
    (globalThis.process.env.TINY_FIREGRID_TIMEOUT_MS === undefined
      ? defaultSimulationTimeout
      : `${globalThis.process.env.TINY_FIREGRID_TIMEOUT_MS} millis`)
  try {
    return Duration.decode(input as Duration.DurationInput)
  } catch (cause) {
    throw new Error(`invalid TINY_FIREGRID_TIMEOUT: ${input}`, { cause })
  }
}

interface DurableStreamsConnection {
  readonly baseUrl: string
  readonly managed: boolean
  readonly close: () => Promise<void>
}

const startManagedDurableStreamsServer = async (): Promise<DurableStreamsConnection> =>
  new Promise((resolve, reject) => {
    const server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
    server.start().then(baseUrl => {
      resolve({
        baseUrl,
        managed: true,
        close: async () => {
          await server.stop()
        },
      })
    }, reject)
  })

const durableStreamsConnection = async (): Promise<DurableStreamsConnection> => {
  const configured = configuredDurableStreamsBaseUrl()
  if (configured !== undefined) {
    return {
      baseUrl: configured,
      managed: false,
      close: async () => {},
    }
  }
  return startManagedDurableStreamsServer()
}

const runnerEnvForSimulation = (
  id: string,
  options: {
    readonly durableStreamsBaseUrl: string
    readonly durableStreamsManaged: boolean
    readonly timeout: Duration.Duration
    readonly tail: boolean
  },
): RunnerEnv => {
  const safeId = sanitizeTinyTracePathSegment(id)
  const runId = sanitizeTinyTracePathSegment(
    globalThis.process.env.TINY_FIREGRID_RUN_ID ?? `${nowStamp()}__${safeId}`,
  )
  return {
    runId,
    simulationId: id,
    namespace: globalThis.process.env.TINY_FIREGRID_NAMESPACE ??
      `tiny-run-${safeId}-${runId.slice(0, 24)}`,
    simulateRoot: simulateRoot(),
    runDir: path.join(runsRoot(), runId),
    durableStreamsBaseUrl: options.durableStreamsBaseUrl,
    durableStreamsManaged: options.durableStreamsManaged,
    timeout: options.timeout,
    tail: options.tail,
  }
}

const tracePathsForRun = (
  env: RunnerEnv,
): RunManifest["trace"] => ({
  markdown: path.join(env.runDir, "trace.md"),
  json: path.join(env.runDir, "trace.json"),
  liveSpansJsonl: path.join(env.runDir, "live-spans.jsonl"),
  otlpJsonl: path.join(env.runDir, "traces.otlp.jsonl"),
  duckdbSql: path.join(env.runDir, "duckdb", "load.sql"),
  duckdb: path.join(env.runDir, "duckdb", "tiny-firegrid.duckdb"),
})

const manifestForRun = (input: {
  readonly env: RunnerEnv
  readonly simulation: TinyFiregridSimulation<unknown>
  readonly status: RunStatus
  readonly createdAt: string
  readonly summary?: Record<string, unknown>
  readonly localization?: ReadonlyArray<string>
  readonly error?: string
}): RunManifest => {
  const trace = tracePathsForRun(input.env)
  const commandSelector = input.env.runId
  return {
    schemaVersion: 1,
    runId: input.env.runId,
    simulationId: input.env.simulationId,
    description: input.simulation.description,
    status: input.status,
    createdAt: input.createdAt,
    updatedAt: nowIso(),
    namespace: input.env.namespace,
    durableStreamsBaseUrl: input.env.durableStreamsBaseUrl,
    timeout: Duration.format(input.env.timeout),
    timeoutMs: Duration.toMillis(input.env.timeout),
    runDir: input.env.runDir,
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    ...(input.localization === undefined ? {} : { localization: input.localization }),
    ...(input.error === undefined ? {} : { error: input.error }),
    trace,
    durableStreams: {
      managed: input.env.durableStreamsManaged,
    },
    commands: {
      show: `pnpm --filter @firegrid/tiny-firegrid simulate:show -- ${commandSelector}`,
      tail: `pnpm --filter @firegrid/tiny-firegrid simulate:tail -- ${commandSelector}`,
      duckdb: `pnpm --filter @firegrid/tiny-firegrid simulate:duckdb -- ${commandSelector}`,
      summary: `pnpm --filter @firegrid/tiny-firegrid simulate:query -- ${commandSelector} "SELECT * FROM tiny_firegrid_span_summary LIMIT 25;"`,
    },
  }
}

const writeManifest = async (manifest: RunManifest): Promise<void> => {
  await ensureDirectory(manifest.runDir)
  await ensureDirectory(simulateRoot())
  await writeFileString(runJsonPath(manifest.runDir), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFileString(latestPath(), `${JSON.stringify({
    runId: manifest.runId,
    simulationId: manifest.simulationId,
    runDir: manifest.runDir,
    status: manifest.status,
    updatedAt: manifest.updatedAt,
  }, null, 2)}\n`)
}

const codexLocalProcessEnv = () => {
  const base = localProcessSpawnEnvFromHostEnv(globalThis.process.env)
  const baselineEnvVars = [
    "HOME",
    "TMPDIR",
    "TEMP",
    "USER",
    "LOGNAME",
    "NPM_CONFIG_CACHE",
    "npm_config_cache",
  ].reduce<Record<string, string>>((envVars, key) => {
    const value = globalThis.process.env[key]
    if (value !== undefined && value.length > 0) envVars[key] = value
    return envVars
  }, { ...(base.baselineEnvVars ?? {}) })
  return {
    ...base,
    baselineEnvVars,
  }
}

const clientLayer = (
  env: TinyFiregridSimulationEnv,
) =>
  FiregridStandaloneLive.pipe(
    Layer.provide(Layer.succeed(FiregridConfig, {
      durableStreamsBaseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
    })),
  )

const runSimulation = async (
  simulation: TinyFiregridSimulation<unknown>,
  options: { readonly tail: boolean },
): Promise<void> => {
  const durableStreams = await durableStreamsConnection()
  const timeout = simulationTimeout()
  const requested = runnerEnvForSimulation(simulation.id, {
    ...options,
    durableStreamsBaseUrl: durableStreams.baseUrl,
    durableStreamsManaged: durableStreams.managed,
    timeout,
  })
  const createdAt = nowIso()
  const running = manifestForRun({ env: requested, simulation, status: "running", createdAt })
  await writeManifest(running)
  await writeFileString(running.trace.liveSpansJsonl, "")
  const live = await makeLiveWriter(running.trace.liveSpansJsonl, requested.tail)
  live.write({
    event: "simulate.run.started",
    runId: requested.runId,
    simulationId: requested.simulationId,
    namespace: requested.namespace,
    durableStreamsBaseUrl: requested.durableStreamsBaseUrl,
    durableStreamsManaged: requested.durableStreamsManaged,
    timeout: Duration.format(requested.timeout),
    runDir: requested.runDir,
  })

  const env: TinyFiregridSimulationEnv = {
    id: simulation.id,
    runId: requested.runId,
    namespace: requested.namespace,
    durableStreamsBaseUrl: requested.durableStreamsBaseUrl,
    runDir: requested.runDir,
    localProcessEnv: codexLocalProcessEnv(),
    processEnv: globalThis.process.env,
  }

  console.log(`[tiny-firegrid] durable streams ${requested.durableStreamsBaseUrl}${requested.durableStreamsManaged ? " (embedded)" : " (external)"}`)
  console.log(`[tiny-firegrid] simulate run ${requested.runId}`)
  console.log(`[tiny-firegrid] artifacts ${requested.runDir}`)
  console.log(`[tiny-firegrid] timeout ${Duration.format(requested.timeout)}`)
  if (requested.tail) console.log("[tiny-firegrid] tailing span events")

  const abortController = new AbortController()
  let interruptedBy: NodeJS.Signals | undefined
  const onProcessSignal = (signal: NodeJS.Signals) => {
    interruptedBy = signal
    live.write({
      event: "simulate.run.interrupted",
      runId: requested.runId,
      signal,
    })
    abortController.abort(new Error(`tiny-firegrid simulation interrupted by ${signal}`))
  }
  globalThis.process.once("SIGINT", onProcessSignal)
  globalThis.process.once("SIGTERM", onProcessSignal)

  try {
    const program = Effect.scoped(
      Effect.gen(function*() {
        yield* Layer.launch(simulation.makeHost(env)).pipe(
          Effect.forkScoped,
          Effect.asVoid,
        )
        return yield* simulation.driver(env).pipe(
          Effect.provide(clientLayer(env)),
        )
      }),
    )
    const traced = await Effect.runPromise(
      runWithTraceRecorder(program, {
        onSpanStart: span => {
          live.write({
            event: "span.started",
            span,
          })
        },
        onSpanEnd: span => {
          live.write({
            event: "span.ended",
            span,
          })
        },
      }).pipe(
        Effect.timeoutFail({
          duration: requested.timeout,
          onTimeout: () => new SimulationRunTimeout({ timeout: requested.timeout }),
        }),
      ),
      { signal: abortController.signal },
    )
    const localization = simulation.localize?.(traced.result)
    const summary = simulation.summarize(traced.result)
    const paths = await writeTinyFiregridTraceRun({
      configuration: simulation.id,
      source: `packages/tiny-firegrid/src/simulations/${simulation.id}.ts`,
      runId: env.runId,
      runDir: env.runDir,
      summary,
      ...(localization === undefined ? {} : { localization }),
      spans: traced.spans,
      fibers: traced.fibers,
    })
    const completed = manifestForRun({
      env: requested,
      simulation,
      status: "completed",
      createdAt,
      summary,
      ...(localization === undefined ? {} : { localization }),
    })
    await writeManifest(completed)
    live.write({
      event: "simulate.run.completed",
      runId: requested.runId,
      summary,
    })
    printRunSummary(completed, paths)
  } catch (error) {
    const timeoutDuration = simulationRunTimeoutDuration(error, requested.timeout)
    if (timeoutDuration !== undefined) {
      live.write({
        event: "simulate.run.timeout",
        runId: requested.runId,
        timeout: Duration.format(timeoutDuration),
      })
    } else if (interruptedBy !== undefined) {
      live.write({
        event: "simulate.run.interruption_observed",
        runId: requested.runId,
        signal: interruptedBy,
      })
    }
    const failed = manifestForRun({
      env: requested,
      simulation,
      status: "failed",
      createdAt,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    })
    await writeManifest(failed)
    live.write({
      event: "simulate.run.failed",
      runId: requested.runId,
      error: failed.error,
    })
    throw error
  } finally {
    globalThis.process.off("SIGINT", onProcessSignal)
    globalThis.process.off("SIGTERM", onProcessSignal)
    await live.close()
    await durableStreams.close()
  }
}

const printRunSummary = (
  manifest: RunManifest,
  paths?: TinyTraceArtifactPaths,
): void => {
  console.log(JSON.stringify({
    simulation: manifest.simulationId,
    runId: manifest.runId,
    status: manifest.status,
    namespace: manifest.namespace,
    runDir: manifest.runDir,
    trace: manifest.trace,
    commands: manifest.commands,
    ...(paths === undefined ? {} : { artifactRunDir: paths.runDir }),
  }, null, 2))
}

const resolveSimulationOrThrow = (id: string): TinyFiregridSimulation<unknown> => {
  const simulation = findTinyFiregridSimulation(id)
  if (simulation === undefined) {
    throw new Error(`unknown tiny-firegrid simulation: ${id}`)
  }
  return simulation
}

const readJson = async <A>(file: string): Promise<A> =>
  JSON.parse(await readFileString(file)) as A

const missingRunMessage = (): string => [
  "no tiny-firegrid simulation run found",
  `expected latest marker: ${latestPath()}`,
  "create one with:",
  "  pnpm --filter @firegrid/tiny-firegrid simulate:run",
].join("\n")

const resolveRunManifest = async (selector = "latest"): Promise<RunManifest> => {
  if (selector === "latest") {
    if (!(await pathExists(latestPath()))) throw new Error(missingRunMessage())
    const latest = await readJson<{ readonly runDir: string }>(latestPath())
    return readJson<RunManifest>(runJsonPath(latest.runDir))
  }

  const directRunDir = path.isAbsolute(selector)
    ? selector
    : path.join(runsRoot(), sanitizeTinyTracePathSegment(selector))
  const directRunJson = runJsonPath(directRunDir)
  if (await pathExists(directRunJson)) return readJson<RunManifest>(directRunJson)

  if (await pathExists(runsRoot())) {
    const entries = await readDirectory(runsRoot())
    const candidates = await Promise.all(entries.map(entry =>
      readJson<RunManifest>(runJsonPath(path.join(runsRoot(), entry)))
        .catch(() => undefined),
    ))
    const match = candidates.find(candidate =>
      candidate?.runId === selector || candidate?.simulationId === selector)
    if (match !== undefined) return match
  }

  throw new Error(`unknown tiny-firegrid simulation run: ${selector}`)
}

const listRuns = async (): Promise<void> => {
  if (!(await pathExists(runsRoot()))) {
    console.log("no local simulation runs")
    return
  }
  const entries = await readDirectory(runsRoot())
  const manifests = (await Promise.all(entries.map(entry =>
    readJson<RunManifest>(runJsonPath(path.join(runsRoot(), entry)))
      .catch(() => undefined),
  ))).filter((manifest): manifest is RunManifest => manifest !== undefined)
  manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  manifests.forEach(manifest => {
    console.log(`${manifest.runId}\t${manifest.status}\t${manifest.simulationId}\t${manifest.updatedAt}`)
  })
}

const runDuckdb = async (
  manifest: RunManifest,
  sql?: string,
): Promise<void> => {
  if (!(await pathExists(manifest.trace.duckdbSql))) {
    throw new Error([
      `run ${manifest.runId} has no DuckDB loader yet`,
      `expected loader: ${manifest.trace.duckdbSql}`,
      `status: ${manifest.status}`,
    ].join("\n"))
  }
  const args = sql === undefined
    ? [manifest.trace.duckdb, "-init", manifest.trace.duckdbSql]
    : [manifest.trace.duckdb, "-init", manifest.trace.duckdbSql, "-c", sql]
  const result = spawnSync("duckdb", args, { stdio: "inherit" })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    globalThis.process.exitCode = result.status ?? 1
  }
}

const tailRun = async (manifest: RunManifest): Promise<void> => {
  if (!(await pathExists(manifest.trace.liveSpansJsonl))) {
    throw new Error(`run ${manifest.runId} has no live span stream: ${manifest.trace.liveSpansJsonl}`)
  }
  const result = spawnSync("tail", ["-n", "+1", "-f", manifest.trace.liveSpansJsonl], {
    stdio: "inherit",
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) globalThis.process.exitCode = result.status ?? 1
}

const parseRunArgs = (
  args: ReadonlyArray<string>,
): { readonly id: string; readonly tail: boolean } => {
  const tail = args.includes("--tail") || args.includes("--attach")
  const positional = args.filter(arg => arg !== "--" && arg !== "--tail" && arg !== "--attach")
  const id = positional[0] ?? tinyFiregridSimulationList()[0]?.id
  if (id === undefined) throw new Error("no simulations registered")
  return { id, tail }
}

const normalizeArgs = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args.filter(arg => arg !== "--")

const main = async (): Promise<void> => {
  const [, , command, ...rawArgs] = globalThis.process.argv
  const args = normalizeArgs(rawArgs)
  await loadTinyFiregridSimulations()
  switch (command) {
    case "list":
      tinyFiregridSimulationList().forEach(simulation => {
        console.log(`${simulation.id}\t${simulation.description}`)
      })
      return
    case "runs":
      await listRuns()
      return
    case "run": {
      const parsed = parseRunArgs(args)
      await runSimulation(resolveSimulationOrThrow(parsed.id), { tail: parsed.tail })
      return
    }
    case "show": {
      const manifest = await resolveRunManifest(args[0] ?? "latest")
      printRunSummary(manifest)
      return
    }
    case "tail":
    case "attach": {
      const manifest = await resolveRunManifest(args[0] ?? "latest")
      await tailRun(manifest)
      return
    }
    case "duckdb": {
      const manifest = await resolveRunManifest(args[0] ?? "latest")
      await runDuckdb(manifest)
      return
    }
    case "query": {
      const selector = args.length > 1 ? args[0] : "latest"
      const sql = args.length > 1 ? args.slice(1).join(" ") : args.join(" ")
      if (sql.length === 0) throw new Error("missing SQL query")
      const manifest = await resolveRunManifest(selector)
      await runDuckdb(manifest, sql)
      return
    }
    default:
      console.log(usage)
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  globalThis.process.exitCode = 1
})
