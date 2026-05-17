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
 *  - firegrid-local-mcp-run.CLI_HELP.1
 *  - firegrid-local-mcp-run.CLI_HELP.2
 *  - firegrid-local-mcp-run.CLI_HELP.3
 *  - firegrid-local-mcp-run.CLI_HELP.4
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
import {
  decodeLaunchConfig,
  decodeLaunchSecretEnvCliValue,
  firegridRuntimeContextMcpDeclaration,
  injectLaunchMcpDeclaration,
  LaunchCliHelp,
  runtimeAgentProtocolValues,
  type LaunchConfig,
  type RuntimeAgentProtocol,
  type RuntimeEnvBinding,
} from "@firegrid/protocol/launch"
import {
  RuntimeEnvResolverPolicy,
  RuntimeContextInsert,
  localProcessSpawnEnvFromHostEnv,
} from "@firegrid/runtime/host-substrate"
import {
  appendRuntimeIngress,
  ensurePathInput,
  FiregridLocalHostLive,
  FiregridMcpServerLayer,
  firegridRunCreatedBy,
  runConfigToIngressRequest,
  runConfigToRuntimeContextIntent,
  runtimeContextMcpPath,
  startRuntime,
} from "@firegrid/host-sdk"
import { Cause, Console, Data, Effect, Either, Exit, Layer, Option, ParseResult } from "effect"

class FiregridCliUsageError extends Data.TaggedError("FiregridCliUsageError")<{
  readonly message: string
}> {}

interface RawRunConfig {
  readonly agentArgv: ReadonlyArray<string>
  readonly agent?: string
  readonly agentProtocol?: RuntimeAgentProtocol
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
  readonly runConfig: LaunchConfig
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

const usageError = (message: string): FiregridCliUsageError =>
  new FiregridCliUsageError({ message })

const rawRunConfigFromCli = (
  input: {
    readonly agentArgv: ReadonlyArray<string>
    readonly agent: Option.Option<string>
    readonly agentProtocol: Option.Option<RuntimeAgentProtocol>
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
      const decoded = decodeLaunchSecretEnvCliValue(input.secretEnv[index]!)
      if (Either.isLeft(decoded)) {
        return yield* Effect.fail(usageError(decoded.left))
      }
      const { authorizedBinding, envBinding } = decoded.right
      const [name] = authorizedBinding
      if (seenTargets.has(name)) {
        return yield* Effect.fail(usageError(
          `--secret-env target ${name} was specified more than once; ` +
            "each child env-var name may be authorized at most once per invocation.",
        ))
      }
      seenTargets.add(name)
      envBindings.push(envBinding)
      authorizedBindings.push(authorizedBinding)
      index += 1
    }

    const agentArgv = input.agentArgv.length === 0
      ? [...noopAgentArgv]
      : [...input.agentArgv]
    const agent = Option.getOrUndefined(input.agent)
    const agentProtocol = Option.getOrUndefined(input.agentProtocol)
    const cwd = Option.getOrUndefined(input.cwd)
    const prompt = Option.getOrUndefined(input.prompt)
    return {
      agentArgv,
      ...(agent === undefined ? {} : { agent }),
      ...(agentProtocol === undefined ? {} : { agentProtocol }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(prompt === undefined ? {} : { prompt }),
      ...(envBindings.length === 0 ? {} : { envBindings }),
      ...(authorizedBindings.length === 0 ? {} : { authorizedBindings }),
    }
  })

const decodeCliRunConfig = (
  raw: RawRunConfig,
  commandName: string,
): Effect.Effect<LaunchConfig, FiregridCliUsageError> =>
  decodeLaunchConfig(raw).pipe(
    Effect.mapError((error) =>
      usageError(`${commandName}: invalid run-config: ${ParseResult.TreeFormatter.formatErrorSync(error)}`)),
  )

// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.1
// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.2
// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.7
// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.8
const executeRun = (config: LaunchConfig, contextId: string) =>
  Effect.gen(function* () {
    // firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.2
    // firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.1
    const intent = runConfigToRuntimeContextIntent(config)
    const contextInsert = yield* RuntimeContextInsert
    const context = yield* contextInsert.insertLocalContext(intent, {
      contextId,
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
    const contextId = `ctx_${crypto.randomUUID()}`
    const address = yield* HttpServer.addressFormattedWith((addr) => Effect.succeed(addr))
    const runConfig = injectLaunchMcpDeclaration(
      config.runConfig,
      firegridRuntimeContextMcpDeclaration(mcpUrl(address, config.mcpPath, contextId)),
    )
    const contextInsert = yield* RuntimeContextInsert
    const context = yield* contextInsert.insertLocalContext(
      runConfigToRuntimeContextIntent(runConfig),
      {
        contextId,
        createdBy: startCreatedBy,
      },
    )
    const ingressRequest = runConfigToIngressRequest(runConfig, context.contextId)
    if (ingressRequest !== undefined) {
      yield* appendRuntimeIngress(ingressRequest)
    }
    yield* printReadyRecord({
      address,
      config,
      contextId: context.contextId,
      durableStreams,
    })
  })

const hostMcpLayer = (
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
    )
    // The workspace package export resolves at runtime through the source
    // export map; eslint's root project widens this composed layer. Keep the
    // coercion explicit rather than hiding it behind no-unsafe-return.
    return layer as Layer.Layer<HttpServer.HttpServer, unknown, never>
  }

const hostAndMcpLayer = (
  durableStreams: DurableStreamsEndpoint,
  config: StartConfig,
): Layer.Layer<HttpServer.HttpServer, unknown, never> => {
  const layer = hostMcpLayer(durableStreams, config).pipe(
    Layer.tap((context) =>
      seedContextAndPrintReady(durableStreams, config).pipe(
        Effect.provide(context),
      )),
  )
  return layer as Layer.Layer<HttpServer.HttpServer, unknown, never>
}

const runWithMcp = (
  durableStreams: DurableStreamsEndpoint,
  namespace: string,
  config: LaunchConfig,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const hostConfig: StartConfig = {
        namespace,
        mcpHost: defaultMcpHost,
        mcpPort: defaultMcpPort,
        mcpPath: defaultMcpPath,
        runConfig: config,
      }
      const context = yield* Layer.build(hostMcpLayer(durableStreams, hostConfig))
      const address = yield* HttpServer.addressFormattedWith((addr) => Effect.succeed(addr)).pipe(
        Effect.provide(context),
      )
      const contextId = `ctx_${crypto.randomUUID()}`
      const normalized = injectLaunchMcpDeclaration(
        config,
        firegridRuntimeContextMcpDeclaration(mcpUrl(address, hostConfig.mcpPath, contextId)),
      )
      return yield* executeRun(normalized, contextId).pipe(
        Effect.provide(context),
      )
    }),
  )

const helpWithDetails = (
  help: {
    readonly description: string
    readonly examples: ReadonlyArray<string>
    readonly defaultValue?: string
  },
): string => [
  help.description,
  help.defaultValue === undefined ? undefined : `Default: ${help.defaultValue}.`,
  help.examples.length === 0 ? undefined : `Example: ${help.examples[0]}`,
].filter((line): line is string => line !== undefined).join("\n")

const rootHelp = `Run Firegrid agents or start a route-scoped local host/MCP server.

Common workflows:
  pnpm firegrid -- start
  pnpm firegrid -- run --prompt "Summarize this repository" -- node agent.mjs
  pnpm firegrid -- run --agent codex-acp --agent-protocol acp -- npx -y @zed-industries/codex-acp@0.14.0
  pnpm firegrid -- run --secret-env ANTHROPIC_API_KEY -- node agent.mjs`

const runHelp = `Run one agent command synchronously through a host-bound RuntimeContext.

Firegrid injects the generated runtime-context MCP server by default before
launch when the selected backend supports MCP setup.

Examples:
  pnpm firegrid -- run -- node -e 'console.log("hello from firegrid")'
  pnpm firegrid -- run --prompt "Summarize this repository" -- node agent.mjs
  pnpm firegrid -- run --agent codex-acp --agent-protocol acp -- npx -y @zed-industries/codex-acp@0.14.0
  pnpm firegrid -- run --secret-env ANTHROPIC_API_KEY -- node agent.mjs`

const startHelp = `Start a local Firegrid host and route-scoped MCP server.

The command prints one JSON ready record of type firegrid.start.ready
containing contextId, mcpUrl, namespace, durableStreamsBaseUrl, and
embeddedDurableStreams, then keeps the host process alive for MCP clients.

Examples:
  pnpm firegrid -- start
  pnpm firegrid -- start --namespace firegrid-local --mcp-port 3333
  pnpm firegrid -- start --prompt "Wait for MCP input" -- node agent.mjs`

const runArgv = Args.text({ name: "agent-argv" }).pipe(
  Args.withDescription(helpWithDetails(LaunchCliHelp.agentArgv)),
  Args.repeated,
)
const startArgv = Args.text({ name: "agent-argv" }).pipe(
  Args.withDescription(
    "Optional agent command and arguments to seed into the hosted RuntimeContext.\n" +
      `Example: ${LaunchCliHelp.agentArgv.examples[0] ?? "node agent.mjs"}`,
  ),
  Args.repeated,
)
const agentOption = Options.text("agent").pipe(
  Options.withPseudoName("NAME"),
  Options.withDescription(helpWithDetails(LaunchCliHelp.agent)),
  Options.optional,
)
const agentProtocolOption = Options.choice("agent-protocol", runtimeAgentProtocolValues).pipe(
  Options.withDescription(helpWithDetails(LaunchCliHelp.agentProtocol)),
  Options.optional,
)
const cwdOption = Options.text("cwd").pipe(
  Options.withPseudoName("PATH"),
  Options.withDescription(helpWithDetails(LaunchCliHelp.cwd)),
  Options.optional,
)
const promptOption = Options.text("prompt").pipe(
  Options.withPseudoName("TEXT"),
  Options.withDescription(helpWithDetails(LaunchCliHelp.prompt)),
  Options.optional,
)
const secretEnvOption = Options.text("secret-env").pipe(
  Options.withPseudoName("NAME[=ENV_NAME]"),
  Options.withDescription(helpWithDetails(LaunchCliHelp.secretEnv)),
  Options.repeated,
)

const runCommand = Command.make(
  "run",
  {
    agent: agentOption,
    agentProtocol: agentProtocolOption,
    cwd: cwdOption,
    prompt: promptOption,
    secretEnv: secretEnvOption,
    agentArgv: runArgv,
  },
  ({ agent, agentArgv, agentProtocol, cwd, prompt, secretEnv }) =>
    Effect.gen(function* () {
      const raw = yield* rawRunConfigFromCli({
        agentArgv,
        agent,
        agentProtocol,
        cwd,
        prompt,
        secretEnv,
        allowEmptyAgentArgv: false,
      })
      const config = yield* decodeCliRunConfig(raw, "firegrid run")
      const durableStreams = yield* durableStreamsEndpoint
      const namespace = namespaceFromEnvOrDefault()
      const exitCode = yield* runWithMcp(durableStreams, namespace, config)
      yield* Effect.sync(() => {
        globalThis.process.exitCode = exitCode
      })
    }).pipe(Effect.scoped),
).pipe(Command.withDescription(runHelp))

const namespaceOption = Options.text("namespace").pipe(
  Options.withPseudoName("NAME"),
  Options.withDescription(
    `Runtime namespace used for durable rows. Default: FIREGRID_RUNTIME_NAMESPACE or ${defaultNamespace}.`,
  ),
  Options.optional,
)
const mcpHostOption = Options.text("mcp-host").pipe(
  Options.withPseudoName("HOST"),
  Options.withDescription("Loopback interface or host address for the MCP HTTP listener."),
  Options.withDefault(defaultMcpHost),
)
const mcpPortOption = Options.integer("mcp-port").pipe(
  Options.withPseudoName("PORT"),
  Options.withDescription("MCP HTTP listener port. Default 0 asks the OS for a free loopback port."),
  Options.withDefault(defaultMcpPort),
)
const mcpPathOption = Options.text("mcp-path").pipe(
  Options.withPseudoName("PATH"),
  Options.withDescription("Base MCP route prefix; runtime contexts are served under /runtime-context/:contextId."),
  Options.withDefault(defaultMcpPath),
)

const startCommand = Command.make(
  "start",
  {
    namespace: namespaceOption,
    mcpHost: mcpHostOption,
    mcpPort: mcpPortOption,
    mcpPath: mcpPathOption,
    agent: agentOption,
    agentProtocol: agentProtocolOption,
    cwd: cwdOption,
    prompt: promptOption,
    secretEnv: secretEnvOption,
    agentArgv: startArgv,
  },
  ({ agent, agentArgv, agentProtocol, cwd, mcpHost, mcpPath, mcpPort, namespace, prompt, secretEnv }) =>
    Effect.gen(function* () {
      const raw = yield* rawRunConfigFromCli({
        agentArgv,
        agent,
        agentProtocol,
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
).pipe(Command.withDescription(startHelp))

const rootCommand = Command.make("firegrid").pipe(
  Command.withDescription(rootHelp),
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
