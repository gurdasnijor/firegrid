import {
  FiregridConfig,
  FiregridStandaloneLive,
} from "@firegrid/client-sdk/firegrid"
// firegrid-observability.TINY_FIREGRID_SIMULATIONS.6
// Accepted bin-only local simulation escape hatch, matching scenario tests.
// eslint-disable-next-line no-restricted-imports
import { DurableStreamTestServer } from "@durable-streams/server"
import {
  localProcessSpawnEnvFromHostEnv,
} from "@firegrid/host-sdk"
import { Effect, Layer } from "effect"
import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  sanitizeTinyTracePathSegment,
  writeTinyFiregridTraceRun,
  type TinyTraceArtifactPaths,
} from "../simulations/trace-artifacts.ts"
import { runWithTraceRecorder } from "../simulations/trace-recorder.ts"
import {
  findTinyFiregridSimulation,
  tinyFiregridSimulations,
} from "../simulations/registry.ts"
import type { TinyFiregridSimulation, TinyFiregridSimulationEnv } from "../simulations/types.ts"

// firegrid-observability.TINY_FIREGRID_SIMULATIONS.1
// firegrid-observability.TINY_FIREGRID_SIMULATIONS.2
// firegrid-observability.TINY_FIREGRID_SIMULATIONS.3
// firegrid-observability.TINY_FIREGRID_SIMULATIONS.4
// firegrid-observability.TINY_FIREGRID_SIMULATIONS.5
// firegrid-observability.TINY_FIREGRID_SIMULATIONS.6
interface RunnerEnv {
  readonly runId: string
  readonly simulationId: string
  readonly namespace: string
  readonly simulateRoot: string
  readonly runDir: string
  readonly durableStreamsBaseUrl: string
  readonly durableStreamsManaged: boolean
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

interface LiveEvent {
  readonly ts: string
  readonly event: string
  readonly [key: string]: unknown
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

const writeLiveEvent = (
  file: string,
  event: LiveEvent,
  tail: boolean,
): void => {
  const line = `${JSON.stringify(event)}\n`
  appendFileSync(file, line)
  if (tail) globalThis.process.stdout.write(line)
}

const configuredDurableStreamsBaseUrl = (): string | undefined => {
  const value = globalThis.process.env.TINY_FIREGRID_DURABLE_STREAMS_URL ??
    globalThis.process.env.FIREGRID_DURABLE_STREAMS_URL
  if (value !== undefined && value.length > 0) return value
  return undefined
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
  await mkdir(manifest.runDir, { recursive: true })
  await mkdir(simulateRoot(), { recursive: true })
  await writeFile(runJsonPath(manifest.runDir), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(latestPath(), `${JSON.stringify({
    runId: manifest.runId,
    simulationId: manifest.simulationId,
    runDir: manifest.runDir,
    status: manifest.status,
    updatedAt: manifest.updatedAt,
  }, null, 2)}\n`)
}

const preflightDurableStreams = async (
  env: RunnerEnv,
  liveSpansJsonl: string,
): Promise<void> => {
  writeLiveEvent(liveSpansJsonl, {
    ts: nowIso(),
    event: "durable_streams.preflight.start",
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
  }, env.tail)
  try {
    const response = await fetch(env.durableStreamsBaseUrl, {
      method: "GET",
      signal: AbortSignal.timeout(2_000),
    })
    writeLiveEvent(liveSpansJsonl, {
      ts: nowIso(),
      event: "durable_streams.preflight.connected",
      durableStreamsBaseUrl: env.durableStreamsBaseUrl,
      managed: env.durableStreamsManaged,
      status: response.status,
    }, env.tail)
  } catch (cause) {
    writeLiveEvent(liveSpansJsonl, {
      ts: nowIso(),
      event: "durable_streams.preflight.failed",
      durableStreamsBaseUrl: env.durableStreamsBaseUrl,
      error: cause instanceof Error ? cause.message : String(cause),
    }, env.tail)
    throw new Error([
      `durable streams server is not reachable at ${env.durableStreamsBaseUrl}`,
      env.durableStreamsManaged
        ? "The runner started an embedded @durable-streams/server, but preflight could not reach it."
        : "Set FIREGRID_DURABLE_STREAMS_URL to a reachable Durable Streams server, or unset it so the runner starts an embedded server.",
      "Reference: https://github.com/durable-streams/durable-streams/blob/main/packages/server/README.md",
    ].join("\n"), { cause })
  }
}

const codexLocalProcessEnv = () => {
  const base = localProcessSpawnEnvFromHostEnv(globalThis.process.env)
  const baselineEnvVars = { ...(base.baselineEnvVars ?? {}) }
  for (const key of [
    "HOME",
    "TMPDIR",
    "TEMP",
    "USER",
    "LOGNAME",
    "NPM_CONFIG_CACHE",
    "npm_config_cache",
  ]) {
    const value = globalThis.process.env[key]
    if (value !== undefined && value.length > 0) baselineEnvVars[key] = value
  }
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
  const requested = runnerEnvForSimulation(simulation.id, {
    ...options,
    durableStreamsBaseUrl: durableStreams.baseUrl,
    durableStreamsManaged: durableStreams.managed,
  })
  const createdAt = nowIso()
  const running = manifestForRun({ env: requested, simulation, status: "running", createdAt })
  await writeManifest(running)
  await writeFile(running.trace.liveSpansJsonl, "")
  writeLiveEvent(running.trace.liveSpansJsonl, {
    ts: nowIso(),
    event: "run.started",
    runId: requested.runId,
    simulationId: requested.simulationId,
    namespace: requested.namespace,
    durableStreamsBaseUrl: requested.durableStreamsBaseUrl,
    durableStreamsManaged: requested.durableStreamsManaged,
    runDir: requested.runDir,
  }, requested.tail)
  await preflightDurableStreams(requested, running.trace.liveSpansJsonl)

  const env: TinyFiregridSimulationEnv = {
    id: simulation.id,
    runId: requested.runId,
    namespace: requested.namespace,
    durableStreamsBaseUrl: requested.durableStreamsBaseUrl,
    runDir: requested.runDir,
    localProcessEnv: codexLocalProcessEnv(),
    processEnv: globalThis.process.env,
  }

  console.log(`[tiny-firegrid] simulate run ${requested.runId}`)
  console.log(`[tiny-firegrid] artifacts ${requested.runDir}`)
  if (requested.tail) console.log("[tiny-firegrid] tailing ended spans")

  let phase = "host.launch.pending"
  let startedSpanCount = 0
  let endedSpanCount = 0
  let lastStartedSpanName: string | undefined
  let lastEndedSpanName: string | undefined
  // firegrid-observability.TINY_FIREGRID_SIMULATIONS.5
  // eslint-disable-next-line local/no-production-js-timers -- Bin-only live simulation progress stream for attached agents.
  const heartbeat = globalThis.setInterval(() => {
    writeLiveEvent(running.trace.liveSpansJsonl, {
      ts: nowIso(),
      event: "run.progress",
      runId: requested.runId,
      phase,
      startedSpanCount,
      endedSpanCount,
      ...(lastStartedSpanName === undefined ? {} : { lastStartedSpanName }),
      ...(lastEndedSpanName === undefined ? {} : { lastEndedSpanName }),
    }, requested.tail)
  }, 5_000)

  try {
    const program = Effect.scoped(
      Effect.gen(function*() {
        yield* Effect.sync(() =>
          writeLiveEvent(running.trace.liveSpansJsonl, {
            ts: nowIso(),
            event: "host.launch.start",
            runId: requested.runId,
          }, requested.tail),
        )
        yield* Effect.sync(() => {
          phase = "host.launch.start"
        })
        yield* Layer.launch(simulation.makeHost(env)).pipe(
          Effect.forkScoped,
          Effect.asVoid,
        )
        yield* Effect.sync(() =>
          writeLiveEvent(running.trace.liveSpansJsonl, {
            ts: nowIso(),
            event: "host.launch.forked",
            runId: requested.runId,
          }, requested.tail),
        )
        yield* Effect.sync(() => {
          phase = "host.launch.forked"
        })
        yield* Effect.sync(() =>
          writeLiveEvent(running.trace.liveSpansJsonl, {
            ts: nowIso(),
            event: "driver.start",
            runId: requested.runId,
          }, requested.tail),
        )
        yield* Effect.sync(() => {
          phase = "driver.running"
        })
        return yield* simulation.driver(env).pipe(
          Effect.provide(clientLayer(env)),
        )
      }),
    )
    const traced = await Effect.runPromise(runWithTraceRecorder(program, {
      onSpanStart: span => {
        startedSpanCount += 1
        lastStartedSpanName = span.name
        writeLiveEvent(running.trace.liveSpansJsonl, {
          ts: nowIso(),
          event: "span.started",
          span,
        }, requested.tail)
      },
      onSpanEnd: span => {
        endedSpanCount += 1
        lastEndedSpanName = span.name
        writeLiveEvent(running.trace.liveSpansJsonl, {
          ts: nowIso(),
          event: "span.ended",
          span,
        }, requested.tail)
      },
    }))
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
    writeLiveEvent(running.trace.liveSpansJsonl, {
      ts: nowIso(),
      event: "run.completed",
      runId: requested.runId,
      summary,
    }, requested.tail)
    printRunSummary(completed, paths)
  } catch (error) {
    const failed = manifestForRun({
      env: requested,
      simulation,
      status: "failed",
      createdAt,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    })
    await writeManifest(failed)
    writeLiveEvent(running.trace.liveSpansJsonl, {
      ts: nowIso(),
      event: "run.failed",
      runId: requested.runId,
      error: failed.error,
    }, requested.tail)
    throw error
  } finally {
    globalThis.clearInterval(heartbeat)
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
  JSON.parse(await readFile(file, "utf8")) as A

const missingRunMessage = (): string => [
  "no tiny-firegrid simulation run found",
  `expected latest marker: ${latestPath()}`,
  "create one with:",
  "  pnpm --filter @firegrid/tiny-firegrid simulate:run",
].join("\n")

const resolveRunManifest = async (selector = "latest"): Promise<RunManifest> => {
  if (selector === "latest") {
    if (!existsSync(latestPath())) throw new Error(missingRunMessage())
    const latest = await readJson<{ readonly runDir: string }>(latestPath())
    return readJson<RunManifest>(runJsonPath(latest.runDir))
  }

  const directRunDir = path.isAbsolute(selector)
    ? selector
    : path.join(runsRoot(), sanitizeTinyTracePathSegment(selector))
  const directRunJson = runJsonPath(directRunDir)
  if (existsSync(directRunJson)) return readJson<RunManifest>(directRunJson)

  if (existsSync(runsRoot())) {
    const entries = await readdir(runsRoot(), { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = await readJson<RunManifest>(runJsonPath(path.join(runsRoot(), entry.name))).catch(() => undefined)
      if (candidate?.runId === selector || candidate?.simulationId === selector) return candidate
    }
  }

  throw new Error(`unknown tiny-firegrid simulation run: ${selector}`)
}

const listRuns = async (): Promise<void> => {
  if (!existsSync(runsRoot())) {
    console.log("no local simulation runs")
    return
  }
  const entries = await readdir(runsRoot(), { withFileTypes: true })
  const manifests: Array<RunManifest> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const manifest = await readJson<RunManifest>(runJsonPath(path.join(runsRoot(), entry.name))).catch(() => undefined)
    if (manifest !== undefined) manifests.push(manifest)
  }
  manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  for (const manifest of manifests) {
    console.log(`${manifest.runId}\t${manifest.status}\t${manifest.simulationId}\t${manifest.updatedAt}`)
  }
}

const runDuckdb = (
  manifest: RunManifest,
  sql?: string,
): void => {
  if (!existsSync(manifest.trace.duckdbSql)) {
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

const tailRun = (manifest: RunManifest): void => {
  if (!existsSync(manifest.trace.liveSpansJsonl)) {
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
  const id = positional[0] ?? tinyFiregridSimulations[0]?.id
  if (id === undefined) throw new Error("no simulations registered")
  return { id, tail }
}

const normalizeArgs = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args.filter(arg => arg !== "--")

const main = async (): Promise<void> => {
  const [, , command, ...rawArgs] = globalThis.process.argv
  const args = normalizeArgs(rawArgs)
  switch (command) {
    case "list":
      for (const simulation of tinyFiregridSimulations) {
        console.log(`${simulation.id}\t${simulation.description}`)
      }
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
      tailRun(manifest)
      return
    }
    case "duckdb": {
      const manifest = await resolveRunManifest(args[0] ?? "latest")
      runDuckdb(manifest)
      return
    }
    case "query": {
      const selector = args.length > 1 ? args[0] : "latest"
      const sql = args.length > 1 ? args.slice(1).join(" ") : args.join(" ")
      if (sql.length === 0) throw new Error("missing SQL query")
      const manifest = await resolveRunManifest(selector)
      runDuckdb(manifest, sql)
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
