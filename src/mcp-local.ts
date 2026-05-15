/**
 * Local MCP context bootstrap.
 *
 * Implements:
 *  - firegrid-local-mcp-run.LOCAL_COMMAND.1
 *  - firegrid-local-mcp-run.LOCAL_COMMAND.2
 *  - firegrid-local-mcp-run.LOCAL_COMMAND.3
 *  - firegrid-local-mcp-run.LOCAL_COMMAND.4
 *  - firegrid-local-mcp-run.LOCAL_COMMAND.5
 *  - firegrid-local-mcp-run.EMBEDDED_DURABLE_STREAMS.1
 *  - firegrid-local-mcp-run.EMBEDDED_DURABLE_STREAMS.2
 *  - firegrid-local-mcp-run.EMBEDDED_DURABLE_STREAMS.3
 *  - firegrid-local-mcp-run.MCP_ROUTE.1
 *  - firegrid-local-mcp-run.MCP_ROUTE.2
 *  - firegrid-local-mcp-run.EFFECT_COMPOSITION.1
 *  - firegrid-local-mcp-run.EFFECT_COMPOSITION.2
 *  - firegrid-local-mcp-run.EFFECT_COMPOSITION.3
 *  - firegrid-local-mcp-run.AUTHORITY_BOUNDARY.1
 *  - firegrid-local-mcp-run.AUTHORITY_BOUNDARY.2
 */

import { DurableStreamTestServer } from "@durable-streams/server"
import { HttpServer } from "@effect/platform"
import { NodeRuntime } from "@effect/platform-node"
import type { DurableTableHeaders } from "@firegrid/protocol"
import type { RuntimeEnvBinding } from "@firegrid/protocol/launch"
import {
  FiregridMcpServerLayer,
  ensurePathInput,
  runtimeContextMcpPath,
} from "@firegrid/runtime/agent-tools"
import {
  FiregridLocalHostLive,
  RuntimeEnvResolverPolicy,
  appendRuntimeIngress,
  decodeRunConfig,
  insertLocalRuntimeContext,
  localProcessSpawnEnvFromHostEnv,
  runConfigToIngressRequest,
  runConfigToRuntimeContextIntent,
  type RunConfig,
} from "@firegrid/runtime"
import { Cause, Console, Data, Effect, Exit, Layer, ParseResult } from "effect"

class FiregridMcpLocalUsageError extends Data.TaggedError(
  "FiregridMcpLocalUsageError",
)<{
  readonly message: string
}> {}

interface RawMcpLocalConfig {
  readonly namespace: string
  readonly mcpHost: string
  readonly mcpPort: number
  readonly mcpPath: string
  readonly runConfig: {
    readonly agentArgv: ReadonlyArray<string>
    readonly cwd?: string
    readonly prompt?: string
    readonly envBindings?: ReadonlyArray<RuntimeEnvBinding>
    readonly authorizedBindings?: ReadonlyArray<readonly [string, string]>
  }
}

interface McpLocalConfig {
  readonly namespace: string
  readonly mcpHost: string
  readonly mcpPort: number
  readonly mcpPath: string
  readonly runConfig: RunConfig
}

interface DurableStreamsEndpoint {
  readonly baseUrl: string
  readonly embedded: boolean
}

interface ReadyRecord {
  readonly type: "firegrid.mcp.local.ready"
  readonly contextId: string
  readonly mcpUrl: string
  readonly namespace: string
  readonly durableStreamsBaseUrl: string
  readonly embeddedDurableStreams: boolean
}

const noopAgentArgv = [
  globalThis.process.execPath,
  "-e",
  "process.exit(0)",
] as const

const defaultNamespace = "firegrid-local-mcp"
const defaultMcpHost = "127.0.0.1"
const defaultMcpPort = 0
const defaultMcpPath = "/mcp"
const createdBy = "firegrid:mcp:local"

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

const usage =
  "Usage: pnpm firegrid:mcp:local [options] [-- agent command...]\n" +
  "Starts a local host-owned MCP server, creates a host-bound RuntimeContext, prints one JSON ready record, and stays alive.\n" +
  "Options:\n" +
  "  --namespace NAME             runtime namespace (default FIREGRID_RUNTIME_NAMESPACE or firegrid-local-mcp)\n" +
  "  --mcp-host HOST              MCP listen host (default 127.0.0.1)\n" +
  "  --mcp-port PORT              MCP listen port (default 0)\n" +
  "  --mcp-path PATH              MCP base path (default /mcp)\n" +
  "  --cwd PATH                   runtime cwd when an agent command is supplied\n" +
  "  --prompt TEXT                seed an initial durable prompt input\n" +
  "  --secret-env NAME[=ENV_NAME] authorize one host env binding for later runtime start"

const usageError = (message: string): FiregridMcpLocalUsageError =>
  new FiregridMcpLocalUsageError({ message })

const readArgv = Effect.sync(() => globalThis.process.argv.slice(2))

const parseSecretEnvFlag = (
  raw: string,
): Effect.Effect<readonly [string, string], FiregridMcpLocalUsageError> => {
  const equalsIndex = raw.indexOf("=")
  const name = equalsIndex === -1 ? raw : raw.slice(0, equalsIndex)
  const envName = equalsIndex === -1 ? raw : raw.slice(equalsIndex + 1)
  if (!ENV_NAME_PATTERN.test(name)) {
    return Effect.fail(usageError(
      `--secret-env expects an env-var identifier, got "${name}".`,
    ))
  }
  if (!ENV_NAME_PATTERN.test(envName)) {
    return Effect.fail(usageError(
      `--secret-env right-hand side "${envName}" is not a valid env-var identifier.`,
    ))
  }
  return Effect.succeed([name, envName] as const)
}

const parseIntegerFlag = (
  flag: string,
  value: string,
): Effect.Effect<number, FiregridMcpLocalUsageError> => {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed >= 0 && String(parsed) === value
    ? Effect.succeed(parsed)
    : Effect.fail(usageError(`${flag} expects a non-negative integer.`))
}

const parseCommand = (
  argv: ReadonlyArray<string>,
): Effect.Effect<RawMcpLocalConfig, FiregridMcpLocalUsageError> =>
  Effect.gen(function* () {
    const separatorIndex = argv.indexOf("--")
    const before = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex)
    const after = separatorIndex === -1 ? [] : argv.slice(separatorIndex + 1)

    const namespaceFromEnv = globalThis.process.env["FIREGRID_RUNTIME_NAMESPACE"]
    let namespace = namespaceFromEnv === undefined || namespaceFromEnv.length === 0
      ? defaultNamespace
      : namespaceFromEnv
    let mcpHost = defaultMcpHost
    let mcpPort = defaultMcpPort
    let mcpPath = defaultMcpPath
    let cwd: string | undefined
    let prompt: string | undefined
    const envBindings: Array<RuntimeEnvBinding> = []
    const authorizedBindings: Array<readonly [string, string]> = []
    const seenTargets = new Set<string>()

    const requireFlagValue = (
      flag: string,
      value: string | undefined,
    ): Effect.Effect<string, FiregridMcpLocalUsageError> =>
      value === undefined || value.length === 0
        ? Effect.fail(usageError(`${flag} requires a value.`))
        : Effect.succeed(value)

    const recordSecretEnv = (
      pair: readonly [string, string],
    ): Effect.Effect<void, FiregridMcpLocalUsageError> => {
      const [name, envName] = pair
      if (seenTargets.has(name)) {
        return Effect.fail(usageError(
          `--secret-env target ${name} was specified more than once.`,
        ))
      }
      seenTargets.add(name)
      envBindings.push({ name, ref: `env:${envName}` })
      authorizedBindings.push([name, envName])
      return Effect.void
    }

    let index = 0
    while (index < before.length) {
      const token = before[index]!
      if (token === "--help" || token === "-h") {
        return yield* Effect.fail(usageError(usage))
      }
      if (token === "--namespace") {
        namespace = yield* requireFlagValue("--namespace", before[index + 1])
        index += 2
        continue
      }
      if (token.startsWith("--namespace=")) {
        namespace = yield* requireFlagValue(
          "--namespace",
          token.slice("--namespace=".length),
        )
        index += 1
        continue
      }
      if (token === "--mcp-host") {
        mcpHost = yield* requireFlagValue("--mcp-host", before[index + 1])
        index += 2
        continue
      }
      if (token.startsWith("--mcp-host=")) {
        mcpHost = yield* requireFlagValue("--mcp-host", token.slice("--mcp-host=".length))
        index += 1
        continue
      }
      if (token === "--mcp-port") {
        const value = yield* requireFlagValue("--mcp-port", before[index + 1])
        mcpPort = yield* parseIntegerFlag("--mcp-port", value)
        index += 2
        continue
      }
      if (token.startsWith("--mcp-port=")) {
        const value = yield* requireFlagValue("--mcp-port", token.slice("--mcp-port=".length))
        mcpPort = yield* parseIntegerFlag("--mcp-port", value)
        index += 1
        continue
      }
      if (token === "--mcp-path") {
        mcpPath = yield* requireFlagValue("--mcp-path", before[index + 1])
        index += 2
        continue
      }
      if (token.startsWith("--mcp-path=")) {
        mcpPath = yield* requireFlagValue("--mcp-path", token.slice("--mcp-path=".length))
        index += 1
        continue
      }
      if (token === "--cwd") {
        cwd = yield* requireFlagValue("--cwd", before[index + 1])
        index += 2
        continue
      }
      if (token.startsWith("--cwd=")) {
        cwd = yield* requireFlagValue("--cwd", token.slice("--cwd=".length))
        index += 1
        continue
      }
      if (token === "--prompt") {
        prompt = yield* requireFlagValue("--prompt", before[index + 1])
        index += 2
        continue
      }
      if (token.startsWith("--prompt=")) {
        prompt = token.slice("--prompt=".length)
        index += 1
        continue
      }
      if (token === "--secret-env") {
        const value = yield* requireFlagValue("--secret-env", before[index + 1])
        yield* parseSecretEnvFlag(value).pipe(Effect.flatMap(recordSecretEnv))
        index += 2
        continue
      }
      if (token.startsWith("--secret-env=")) {
        const value = yield* requireFlagValue(
          "--secret-env",
          token.slice("--secret-env=".length),
        )
        yield* parseSecretEnvFlag(value).pipe(Effect.flatMap(recordSecretEnv))
        index += 1
        continue
      }
      return yield* Effect.fail(usageError(
        `firegrid:mcp:local does not recognize the option "${token}" before "--".\n${usage}`,
      ))
    }

    return {
      namespace,
      mcpHost,
      mcpPort,
      mcpPath,
      runConfig: {
        agentArgv: after.length === 0 ? [...noopAgentArgv] : after,
        ...(cwd === undefined ? {} : { cwd }),
        ...(prompt === undefined ? {} : { prompt }),
        ...(envBindings.length === 0 ? {} : { envBindings }),
        ...(authorizedBindings.length === 0 ? {} : { authorizedBindings }),
      },
    }
  })

const decodeConfig = (
  raw: RawMcpLocalConfig,
): Effect.Effect<McpLocalConfig, FiregridMcpLocalUsageError> =>
  decodeRunConfig(raw.runConfig).pipe(
    Effect.map((runConfig) => ({
      namespace: raw.namespace,
      mcpHost: raw.mcpHost,
      mcpPort: raw.mcpPort,
      mcpPath: raw.mcpPath,
      runConfig,
    })),
    Effect.mapError((error) =>
      usageError(`firegrid:mcp:local: invalid run config: ${ParseResult.TreeFormatter.formatErrorSync(error)}`)),
  )

const envPolicyLayer = (
  authorizedBindings: ReadonlyArray<readonly [string, string]>,
) =>
  Layer.succeed(
    RuntimeEnvResolverPolicy,
    RuntimeEnvResolverPolicy.make({
      authorizedBindings,
      lookupEnv: (name: string) => globalThis.process.env[name],
    }),
  )

const durableTableHeadersFromEnv = (): DurableTableHeaders | undefined => {
  const token = globalThis.process.env["FIREGRID_DURABLE_STREAMS_TOKEN"]
  return token === undefined || token.length === 0
    ? undefined
    : { Authorization: () => `Bearer ${token}` }
}

const durableStreamsEndpoint = Effect.acquireRelease(
  Effect.tryPromise(async (): Promise<
    DurableStreamsEndpoint & { readonly server?: DurableStreamTestServer }
  > => {
    const configured = globalThis.process.env["DURABLE_STREAMS_BASE_URL"]
    if (configured !== undefined && configured.length > 0) {
      return {
        baseUrl: configured,
        embedded: false,
      }
    }
    const server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
    const baseUrl = await server.start()
    return {
      baseUrl,
      embedded: true,
      server,
    }
  }),
  (endpoint) =>
    endpoint.server === undefined
      ? Effect.void
      : Effect.promise(() => endpoint.server.stop()).pipe(
        Effect.catchAll(() => Effect.void),
      ),
).pipe(
  Effect.map((endpoint): DurableStreamsEndpoint => ({
    baseUrl: endpoint.baseUrl,
    embedded: endpoint.embedded,
  })),
)

const mcpUrl = (address: string, path: string, contextId: string): string => {
  const mcpPath = runtimeContextMcpPath(ensurePathInput(path)).replace(
    ":contextId",
    encodeURIComponent(contextId),
  )
  return new URL(mcpPath, address).toString()
}

const printReadyRecord = (
  options: {
    readonly address: string
    readonly config: McpLocalConfig
    readonly contextId: string
    readonly durableStreams: DurableStreamsEndpoint
  },
) => {
  const record: ReadyRecord = {
    type: "firegrid.mcp.local.ready",
    contextId: options.contextId,
    mcpUrl: mcpUrl(options.address, options.config.mcpPath, options.contextId),
    namespace: options.config.namespace,
    durableStreamsBaseUrl: options.durableStreams.baseUrl,
    embeddedDurableStreams: options.durableStreams.embedded,
  }
  return Console.log(JSON.stringify(record))
}

const seedContextAndPrintReady = (
  durableStreams: DurableStreamsEndpoint,
  config: McpLocalConfig,
) =>
  Effect.gen(function* () {
    const context = yield* insertLocalRuntimeContext(
      runConfigToRuntimeContextIntent(config.runConfig),
      {
        contextId: `ctx_${crypto.randomUUID()}`,
        createdBy,
      },
    )
    const ingressRequest = runConfigToIngressRequest(config.runConfig, context.contextId)
    if (ingressRequest !== undefined) {
      yield* appendRuntimeIngress(ingressRequest)
    }
    const address = yield* HttpServer.addressFormattedWith((addr) => Effect.succeed(addr))
    yield* printReadyRecord({
      address,
      config,
      contextId: context.contextId,
      durableStreams,
    })
  })

const hostAndMcpLayer = (
  durableStreams: DurableStreamsEndpoint,
  config: McpLocalConfig,
): Layer.Layer<HttpServer.HttpServer, unknown, never> =>
  {
    const headers = durableTableHeadersFromEnv()
    const layer = FiregridMcpServerLayer({
      host: config.mcpHost,
      port: config.mcpPort,
      path: ensurePathInput(config.mcpPath),
    }).pipe(
      Layer.provideMerge(FiregridLocalHostLive(
        {
          durableStreamsBaseUrl: durableStreams.baseUrl,
          namespace: config.namespace,
          input: true,
          ...(headers === undefined ? {} : { headers }),
          localProcessEnv: localProcessSpawnEnvFromHostEnv(globalThis.process.env),
        },
        envPolicyLayer(config.runConfig.authorizedBindings ?? []),
      )),
      Layer.tap((context) =>
        seedContextAndPrintReady(durableStreams, config).pipe(
          Effect.provide(context),
        )),
    )
    // The workspace package export resolves at runtime through the
    // source export map; eslint's root project sees the composed layer
    // as `Layer<any, ..., never>` here, while the function boundary
    // pins the required no-environment shape before `Layer.launch`.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return layer
  }

const program: Effect.Effect<number, never, never> = Effect.gen(function* () {
  const argv = yield* readArgv
  const raw = yield* parseCommand(argv)
  const config = yield* decodeConfig(raw)
  const durableStreams = yield* durableStreamsEndpoint
  return yield* Layer.launch(hostAndMcpLayer(durableStreams, config))
}).pipe(
  Effect.scoped,
  Effect.catchTag("FiregridMcpLocalUsageError", (error) =>
    Console.error(error.message).pipe(Effect.as(2))),
  Effect.catchAllCause((cause) =>
    Console.error(`firegrid:mcp:local failed: ${Cause.pretty(cause)}`).pipe(
      Effect.as(1),
    )),
)

function teardown<E, A>(
  exit: Exit.Exit<E, A>,
  onExit: (code: number) => void,
): void {
  Exit.match(exit, {
    onSuccess: (value) => onExit(typeof value === "number" ? value : 0),
    onFailure: (cause) => onExit(Cause.isInterruptedOnly(cause) ? 0 : 1),
  })
}

NodeRuntime.runMain(program, {
  disableErrorReporting: true,
  teardown,
})
