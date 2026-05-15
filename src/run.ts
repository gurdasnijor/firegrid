/**
 * Unified Firegrid CLI entrypoint.
 *
 * Usage:
 *
 *   pnpm firegrid -- run -- node -e 'console.log(JSON.stringify({hello:"firegrid"}))'
 *   pnpm firegrid -- start
 *   pnpm firegrid -- start -- [agent command...]
 *
 * Compatibility scripts:
 *
 *   pnpm firegrid:run -- <agent>
 *   pnpm firegrid:start
 *
 * Harness contract:
 *
 *   This file is the test/smoke harness for the entire product.
 *   Scenarios under `scenarios/firegrid/` spawn `pnpm firegrid -- ...`
 *   and assert on its stdout / exit code. They do not reach past the
 *   CLI boundary into adapter / host / codec internals.
 *
 *   If a smoke needs behavior the CLI does not currently expose,
 *   extend the CLI (and the launch schema it consumes) here — do
 *   not duplicate the wiring in a scratch file or scenario. See
 *   `docs/contributing/architecture-map.md` for the current
 *   subcommand intent and the list of known CLI gaps before
 *   extending.
 *
 * Subcommand intent (see architecture-map for the full matrix +
 * gaps):
 *
 *   - `run` composes `FiregridLocalHostLive` only and drives the
 *     runtime workflow. It does NOT start the MCP server and does
 *     NOT thread `mcpServers` into the spawned agent's session.
 *   - `start` composes `FiregridLocalHostLive + FiregridMcpServerLayer`,
 *     seeds a `RuntimeContext`, and prints a `firegrid.start.ready`
 *     JSON line with `mcpUrl`. It does NOT launch the agent argv
 *     accepted after `--`; that argv is recorded into the context
 *     intent for an external `startRuntime` caller.
 *
 * Implements:
 *  - firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.1..6
 *  - firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.7 — --cwd
 *  - firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.8 — --prompt
 *  - firegrid-workflow-driven-runtime.VALIDATION.2
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

import { Args, Command, Options } from "@effect/cli"
import { HttpServer } from "@effect/platform"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { DurableStreamTestServer } from "@durable-streams/server"
import type { DurableTableHeaders } from "@firegrid/protocol"
import { type RuntimeEnvBinding } from "@firegrid/protocol/launch"
import {
  FiregridLocalHostLive,
  RuntimeEnvResolverPolicy,
  appendRuntimeIngress,
  decodeRunConfig,
  firegridRunCreatedBy,
  insertLocalRuntimeContext,
  localProcessSpawnEnvFromHostEnv,
  runConfigRequiresInput,
  runConfigToIngressRequest,
  runConfigToRuntimeContextIntent,
  startRuntime,
  type RunConfig,
} from "@firegrid/runtime"
import {
  FiregridMcpServerLayer,
  ensurePathInput,
  runtimeContextMcpPath,
} from "@firegrid/runtime/agent-tools"
import { Cause, Console, Data, Effect, Exit, Layer, Option, ParseResult } from "effect"

class FiregridCliUsageError extends Data.TaggedError("FiregridCliUsageError")<{
  readonly message: string
}> {}

interface RawRunConfig {
  readonly agentArgv: ReadonlyArray<string>
  readonly cwd?: string
  readonly prompt?: string
  readonly envBindings?: ReadonlyArray<RuntimeEnvBinding>
  readonly authorizedBindings?: ReadonlyArray<readonly [string, string]>
}

interface DurableStreamsEndpoint {
  readonly baseUrl: string
  readonly embedded: boolean
}

interface StartConfig {
  readonly namespace: string
  readonly mcpHost: string
  readonly mcpPort: number
  readonly mcpPath: string
  readonly runConfig: RunConfig
}

interface ReadyRecord {
  readonly type: "firegrid.start.ready"
  readonly version: 1
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

const defaultNamespace = "firegrid-local"
const defaultMcpHost = "127.0.0.1"
const defaultMcpPort = 0
const defaultMcpPath = "/mcp"
const startCreatedBy = "firegrid:start"

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

const usageError = (message: string): FiregridCliUsageError =>
  new FiregridCliUsageError({ message })

// Parse a single --secret-env value. Accepts:
//   NAME           -> binding { name: NAME, ref: env:NAME }
//   NAME=ENV_NAME  -> binding { name: NAME, ref: env:ENV_NAME }
// The flag never accepts a literal secret value; both halves are env-var
// identifiers only.
const parseSecretEnvFlag = (
  raw: string,
): Effect.Effect<readonly [string, string], FiregridCliUsageError> => {
  const equalsIndex = raw.indexOf("=")
  const name = equalsIndex === -1 ? raw : raw.slice(0, equalsIndex)
  const envName = equalsIndex === -1 ? raw : raw.slice(equalsIndex + 1)
  if (!ENV_NAME_PATTERN.test(name)) {
    return Effect.fail(usageError(
      `--secret-env expects an env-var identifier, got "${name}". ` +
        "Use --secret-env NAME or --secret-env NAME=ENV_NAME; values are never accepted on the command line.",
    ))
  }
  if (!ENV_NAME_PATTERN.test(envName)) {
    return Effect.fail(usageError(
      `--secret-env right-hand side "${envName}" is not a valid env-var identifier. ` +
        "--secret-env names host env vars; it does not accept secret values.",
    ))
  }
  return Effect.succeed([name, envName] as const)
}

const rawRunConfigFromCli = (
  input: {
    readonly agentArgv: ReadonlyArray<string>
    readonly cwd: Option.Option<string>
    readonly prompt: Option.Option<string>
    readonly secretEnv: ReadonlyArray<string>
    readonly allowEmptyAgentArgv: boolean
  },
): Effect.Effect<RawRunConfig, FiregridCliUsageError> =>
  Effect.gen(function* () {
    if (!input.allowEmptyAgentArgv && input.agentArgv.length === 0) {
      return yield* Effect.fail(usageError(
        "firegrid run requires an agent command after `--`.\n" +
          "Example: pnpm firegrid -- run -- node -e 'console.log(\"hello\")'",
      ))
    }

    const envBindings: Array<RuntimeEnvBinding> = []
    const authorizedBindings: Array<readonly [string, string]> = []
    const seenTargets = new Set<string>()
    let index = 0
    while (index < input.secretEnv.length) {
      const [name, envName] = yield* parseSecretEnvFlag(input.secretEnv[index]!)
      if (seenTargets.has(name)) {
        return yield* Effect.fail(usageError(
          `--secret-env target ${name} was specified more than once; ` +
            "each child env-var name may be authorized at most once per invocation.",
        ))
      }
      seenTargets.add(name)
      envBindings.push({ name, ref: `env:${envName}` })
      authorizedBindings.push([name, envName])
      index += 1
    }

    const agentArgv = input.agentArgv.length === 0
      ? [...noopAgentArgv]
      : [...input.agentArgv]
    const cwd = Option.getOrUndefined(input.cwd)
    const prompt = Option.getOrUndefined(input.prompt)
    return {
      agentArgv,
      ...(cwd === undefined ? {} : { cwd }),
      ...(prompt === undefined ? {} : { prompt }),
      ...(envBindings.length === 0 ? {} : { envBindings }),
      ...(authorizedBindings.length === 0 ? {} : { authorizedBindings }),
    }
  })

const decodeCliRunConfig = (
  raw: RawRunConfig,
  commandName: string,
): Effect.Effect<RunConfig, FiregridCliUsageError> =>
  decodeRunConfig(raw).pipe(
    Effect.mapError((error) =>
      usageError(`${commandName}: invalid run-config: ${ParseResult.TreeFormatter.formatErrorSync(error)}`)),
  )

// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.1
// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.2
// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.7
// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.8
const executeRun = (config: RunConfig) =>
  Effect.gen(function* () {
    // firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.2
    // firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.1
    const intent = runConfigToRuntimeContextIntent(config)
    const context = yield* insertLocalRuntimeContext(intent, {
      contextId: `ctx_${crypto.randomUUID()}`,
      createdBy: firegridRunCreatedBy,
    })
    yield* Console.log(
      `firegrid:run: launched context ${context.contextId} (${config.agentArgv.join(" ")})`,
    )

    const ingressRequest = runConfigToIngressRequest(config, context.contextId)
    if (ingressRequest !== undefined) {
      yield* appendRuntimeIngress(ingressRequest)
      yield* Console.log(
        `firegrid:run: appended initial prompt input for ${context.contextId}`,
      )
    }

    const result = yield* startRuntime({ contextId: context.contextId })
    yield* Console.log(
      `firegrid:run: context ${context.contextId} exited (attempt ${result.activityAttempt}, exitCode ${result.exitCode}${
        result.signal === undefined ? "" : `, signal ${result.signal}`
      })`,
    )
    return result.exitCode
  })

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

// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.1
// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.3
//
// Build the local host layer for `firegrid run`. The CLI mirrors the
// `firegrid start` local-defaults strategy: `durableStreamsBaseUrl`
// and `namespace` are taken from the env when supplied, otherwise the
// embedded `DurableStreamTestServer` and `firegrid-local` defaults
// take over. This lets `pnpm firegrid -- run -- <agent>` succeed in
// local dev without operators having to export
// DURABLE_STREAMS_BASE_URL / FIREGRID_RUNTIME_NAMESPACE first.
const runHostLayer = (
  config: RunConfig,
  durableStreams: DurableStreamsEndpoint,
  namespace: string,
) => {
  const headers = durableTableHeadersFromEnv()
  const inputFromEnv = globalThis.process.env["FIREGRID_RUNTIME_INPUT_ENABLED"] === "true"
  return FiregridLocalHostLive(
    {
      durableStreamsBaseUrl: durableStreams.baseUrl,
      namespace,
      ...(inputFromEnv || runConfigRequiresInput(config) ? { input: true } : {}),
      ...(headers === undefined ? {} : { headers }),
      localProcessEnv: localProcessSpawnEnvFromHostEnv(globalThis.process.env),
    },
    envPolicyLayer(config.authorizedBindings ?? []),
  )
}

const namespaceFromEnvOrDefault = (): string => {
  const fromEnv = globalThis.process.env["FIREGRID_RUNTIME_NAMESPACE"]
  return fromEnv === undefined || fromEnv.length === 0 ? defaultNamespace : fromEnv
}

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
  // runtimeContextMcpPath returns the route template owned by the MCP host
  // module; this CLI only substitutes the path authority value it just created.
  const mcpPath = runtimeContextMcpPath(ensurePathInput(path)).replace(
    ":contextId",
    encodeURIComponent(contextId),
  )
  return new URL(mcpPath, address).toString()
}

const printReadyRecord = (
  options: {
    readonly address: string
    readonly config: StartConfig
    readonly contextId: string
    readonly durableStreams: DurableStreamsEndpoint
  },
) => {
  const record: ReadyRecord = {
    type: "firegrid.start.ready",
    version: 1,
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
  config: StartConfig,
) =>
  Effect.gen(function* () {
    const context = yield* insertLocalRuntimeContext(
      runConfigToRuntimeContextIntent(config.runConfig),
      {
        contextId: `ctx_${crypto.randomUUID()}`,
        createdBy: startCreatedBy,
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
  config: StartConfig,
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
    // The workspace package export resolves at runtime through the source
    // export map; eslint's root project widens this composed layer. Keep the
    // coercion explicit rather than hiding it behind no-unsafe-return.
    return layer as Layer.Layer<HttpServer.HttpServer, unknown, never>
  }

const runArgv = Args.text({ name: "agent-argv" }).pipe(Args.repeated)
const cwdOption = Options.text("cwd").pipe(Options.optional)
const promptOption = Options.text("prompt").pipe(Options.optional)
const secretEnvOption = Options.text("secret-env").pipe(Options.repeated)

const runCommand = Command.make(
  "run",
  {
    cwd: cwdOption,
    prompt: promptOption,
    secretEnv: secretEnvOption,
    agentArgv: runArgv,
  },
  ({ agentArgv, cwd, prompt, secretEnv }) =>
    Effect.gen(function* () {
      const raw = yield* rawRunConfigFromCli({
        agentArgv,
        cwd,
        prompt,
        secretEnv,
        allowEmptyAgentArgv: false,
      })
      const config = yield* decodeCliRunConfig(raw, "firegrid run")
      const durableStreams = yield* durableStreamsEndpoint
      const namespace = namespaceFromEnvOrDefault()
      const exitCode = yield* executeRun(config).pipe(
        Effect.provide(runHostLayer(config, durableStreams, namespace)),
      )
      yield* Effect.sync(() => {
        globalThis.process.exitCode = exitCode
      })
    }).pipe(Effect.scoped),
)

const namespaceOption = Options.text("namespace").pipe(Options.optional)
const mcpHostOption = Options.text("mcp-host").pipe(Options.withDefault(defaultMcpHost))
const mcpPortOption = Options.integer("mcp-port").pipe(Options.withDefault(defaultMcpPort))
const mcpPathOption = Options.text("mcp-path").pipe(Options.withDefault(defaultMcpPath))

const startCommand = Command.make(
  "start",
  {
    namespace: namespaceOption,
    mcpHost: mcpHostOption,
    mcpPort: mcpPortOption,
    mcpPath: mcpPathOption,
    cwd: cwdOption,
    prompt: promptOption,
    secretEnv: secretEnvOption,
    agentArgv: runArgv,
  },
  ({ agentArgv, cwd, mcpHost, mcpPath, mcpPort, namespace, prompt, secretEnv }) =>
    Effect.gen(function* () {
      const raw = yield* rawRunConfigFromCli({
        agentArgv,
        cwd,
        prompt,
        secretEnv,
        allowEmptyAgentArgv: true,
      })
      const runConfig = yield* decodeCliRunConfig(raw, "firegrid start")
      const durableStreams = yield* durableStreamsEndpoint
      const namespaceFromEnv = globalThis.process.env["FIREGRID_RUNTIME_NAMESPACE"]
      const config: StartConfig = {
        namespace: Option.getOrElse(namespace, () =>
          namespaceFromEnv === undefined || namespaceFromEnv.length === 0
            ? defaultNamespace
            : namespaceFromEnv),
        mcpHost,
        mcpPort,
        mcpPath,
        runConfig,
      }
      yield* Layer.launch(hostAndMcpLayer(durableStreams, config))
    }).pipe(Effect.scoped),
)

const rootCommand = Command.make("firegrid").pipe(
  Command.withSubcommands([runCommand, startCommand]),
)

const cli = Command.run(rootCommand, {
  name: "Firegrid CLI",
  version: "0.0.0",
})

const program = cli(globalThis.process.argv).pipe(
  Effect.provide(NodeContext.layer),
  Effect.catchTag("FiregridCliUsageError", (error) =>
    Console.error(error.message).pipe(
      Effect.zipRight(Effect.sync(() => {
        globalThis.process.exitCode = 2
      })),
    )),
  Effect.catchAllCause((cause) =>
    Console.error(`firegrid failed: ${Cause.pretty(cause)}`).pipe(
      Effect.zipRight(Effect.sync(() => {
        globalThis.process.exitCode = Cause.isInterruptedOnly(cause) ? 0 : 1
      })),
    )),
)

function teardown<E, A>(
  exit: Exit.Exit<E, A>,
  onExit: (code: number) => void,
): void {
  Exit.match(exit, {
    onSuccess: () => onExit(globalThis.process.exitCode ?? 0),
    onFailure: (cause) => onExit(Cause.isInterruptedOnly(cause) ? 0 : 1),
  })
}

NodeRuntime.runMain(program, {
  disableErrorReporting: true,
  teardown,
})
