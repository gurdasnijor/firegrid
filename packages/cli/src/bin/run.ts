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
import { createRegistryHooks, DurableStreamTestServer } from "@durable-streams/server"
import type { DurableTableHeaders } from "@firegrid/protocol"
import {
  decodeLaunchConfig,
  decodeLaunchSecretEnvCliValue,
  LaunchCliHelp,
  runtimeAgentProtocolValues,
  type LaunchConfig,
  type RuntimeAgentProtocol,
  type RuntimeEnvBinding,
} from "@firegrid/protocol/launch"
// firegrid-host-sdk.PACKAGE_GRAPH.5: @firegrid/cli is a host process. It may
// compose @firegrid/host-sdk host authority directly, but must not import
// @firegrid/runtime substrate or rely on client-sdk durable-table writes.
import {
  appendRuntimeIngress,
  AcpStdioEdge,
  AcpStdioEdgeLive,
  ensurePathInput,
  FiregridLocalHostLive,
  FiregridMcpServerLayer,
  firegridRunCreatedBy,
  localProcessSpawnEnvFromHostEnv,
  RuntimeEnvResolverPolicy,
  runConfigToIngressRequest,
  runtimeContextMcpPath,
  startRuntime,
  type AcpStdioSessionRuntimeRequest,
} from "@firegrid/host-sdk"
import { Firegrid, FiregridConfig, FiregridLive, local } from "@firegrid/client-sdk/firegrid"
import {
  checkFiregridOtelFileWritable,
  FiregridOtelLive,
  resolveFiregridOtelActiveExporter,
  resolveFiregridOtelFileDestination,
  type FiregridOtelDestination,
} from "@firegrid/observability/node"
import { Cause, Console, Context, Data, Effect, Either, Exit, Layer, Option, ParseResult } from "effect"
import { Readable, Writable } from "node:stream"

class FiregridCliUsageError extends Data.TaggedError("FiregridCliUsageError")<{
  readonly message: string
}> {}

class FiregridRunError extends Data.TaggedError("FiregridRunError")<{
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

interface AcpConfig {
  readonly namespace: string
  readonly runConfig: LaunchConfig
  readonly otelDestination?: FiregridOtelDestination
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
      return yield* usageError(
        "firegrid run requires an agent command after `--`.\n" +
          "Example: pnpm firegrid -- run -- node -e 'console.log(\"hello\")'",
      )
    }

    const envBindings: Array<RuntimeEnvBinding> = []
    const authorizedBindings: Array<readonly [string, string]> = []
    const seenTargets = new Set<string>()
    let index = 0
    while (index < input.secretEnv.length) {
      const decoded = decodeLaunchSecretEnvCliValue(input.secretEnv[index]!)
      if (Either.isLeft(decoded)) {
        return yield* usageError(decoded.left)
      }
      const { authorizedBinding, envBinding } = decoded.right
      const [name] = authorizedBinding
      if (seenTargets.has(name)) {
        return yield* usageError(
          `--secret-env target ${name} was specified more than once; ` +
            "each child env-var name may be authorized at most once per invocation.",
        )
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
// CLI session identity. Each `firegrid run`/`start` invocation is a fresh
// caller-owned session, so the externalKey id is a generated uuid; the
// source distinguishes the two CLI entrypoints. TFIND-048: the CLI no
// longer pre-derives the contextId to bake an MCP URL — the host owns
// the runtime-context MCP URL and injects it post-materialization at
// start. The CLI only expresses the URL-less marker.
type CliExternalKey = { readonly source: string; readonly id: string }

const cliExternalKey = (kind: "run" | "start"): CliExternalKey => ({
  source: `firegrid:cli:${kind}`,
  id: crypto.randomUUID(),
})

// TFIND-048: the CLI requests the host-owned runtime-context MCP server
// via the URL-less marker (replacing the deleted pre-`createOrLoad`
// `injectLaunchMcpDeclaration`). Both `firegrid run` and `firegrid start`
// attach it by default, mirroring the prior always-inject behavior; the
// host resolves and injects the concrete contextId-scoped URL at start.
const withRuntimeContextMcpMarker = (config: LaunchConfig): LaunchConfig => ({
  ...config,
  runtimeContextMcp: { enabled: true },
})

// sessions.createOrLoad expects `runtime: PublicLaunchRuntimeIntent`. The CLI
// decodes a LaunchConfig from argv; the protocol-owned `local` builder
// produces the public intent. Centralized here so the LaunchConfig field
// copy is a single review point.
const launchConfigToPublicRuntimeIntent = (config: LaunchConfig) => {
  const optional = {
    agent: config.agent,
    agentProtocol: config.agentProtocol,
    cwd: config.cwd,
    envBindings: config.envBindings,
    mcpServers: config.mcpServers,
    runtimeContextMcp: config.runtimeContextMcp,
  }
  const present = Object.fromEntries(
    Object.entries(optional).filter((entry) => entry[1] !== undefined),
  )
  return local.jsonl({ argv: config.agentArgv, ...present })
}

const executeRun = (config: LaunchConfig, externalKey: CliExternalKey) =>
  Effect.gen(function* () {
    const firegrid = yield* Firegrid
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey,
      runtime: launchConfigToPublicRuntimeIntent(config),
      createdBy: firegridRunCreatedBy,
    })
    yield* Console.log(
      `firegrid:run: launched context ${session.contextId} (${config.agentArgv.join(" ")})`,
    )

    // tf-2osu: no explicit readiness wait — appendRuntimeIngress and
    // startRuntime own a bounded "context materialized" barrier internally.
    const initialPrompt = runConfigToIngressRequest(config, session.contextId)
    if (initialPrompt !== undefined) {
      yield* appendRuntimeIngress(initialPrompt)
      yield* Console.log(
        `firegrid:run: appended initial prompt input for ${session.contextId}`,
      )
    }

    const result = yield* startRuntime({ contextId: session.contextId }).pipe(
      Effect.mapError((cause) =>
        new FiregridRunError({
          message: `firegrid run failed to start session ${session.contextId}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        })),
    )
    yield* Console.log(
      `firegrid:run: context ${session.contextId} exited (attempt ${result.activityAttempt}, exitCode ${result.exitCode}${
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

// tf-yxdd disposition (a): named CLI local-dev exception.
// firegrid-local-mcp-run.EMBEDDED_DURABLE_STREAMS.2-3
// firegrid-local-mcp-run.EFFECT_COMPOSITION.2
// This owns only scoped loopback DurableStreamTestServer lifecycle when
// DURABLE_STREAMS_BASE_URL is absent. Production runs attach to an explicit
// endpoint; durable table/workflow authority stays in host/runtime layers.
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
    // Bind the embedded durable-streams server to a fixed port and populate the
    // __registry__ stream so the durable-streams test-ui (examples/test-ui) can
    // enumerate live streams. Hooks go through the constructor because
    // `server.options` is private in @durable-streams/server@0.3.1, and
    // createRegistryHooks needs the store (only available post-construction)
    // plus the server URL, so a const holder bridges the two: the constructor
    // closures read `registry.current`, which is populated right after.
    const registry: { current?: ReturnType<typeof createRegistryHooks> } = {}
    const server = new DurableStreamTestServer({
      port: 4437,
      host: "127.0.0.1",
      onStreamCreated: (event) => registry.current?.onStreamCreated(event),
      onStreamDeleted: (event) => registry.current?.onStreamDeleted(event),
    })
    registry.current = createRegistryHooks(server.store, "http://127.0.0.1:4437")
    const baseUrl = await server.start()
    return {
      baseUrl,
      embedded: true,
      server,
    }
  }),
  (endpoint) => {
    const server = endpoint.server
    return server === undefined
      ? Effect.void
      : Effect.tryPromise(() => server.stop()).pipe(Effect.ignore)
  },
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

const firegridLocalHostLayer = (
  durableStreams: DurableStreamsEndpoint,
  namespace: string,
  runConfig: LaunchConfig,
  headers: DurableTableHeaders | undefined,
) =>
  FiregridLocalHostLive(
    {
      durableStreamsBaseUrl: durableStreams.baseUrl,
      namespace,
      input: true,
      ...(headers === undefined ? {} : { headers }),
      localProcessEnv: localProcessSpawnEnvFromHostEnv(globalThis.process.env),
    },
    envPolicyLayer(runConfig.authorizedBindings ?? []),
  )

const seedContextAndPrintReady = (
  durableStreams: DurableStreamsEndpoint,
  config: StartConfig,
) =>
  Effect.gen(function* () {
    const externalKey = cliExternalKey("start")
    const address = yield* HttpServer.addressFormattedWith((addr) => Effect.succeed(addr))
    // TFIND-048: express the URL-less marker; the in-process host injects
    // the concrete contextId-scoped URL at start. No pre-`createOrLoad`
    // injection, no contextId pre-derivation.
    const runConfig = withRuntimeContextMcpMarker(config.runConfig)
    // `firegrid start` seeds the session and keeps the host alive for MCP
    // clients; it does not run to completion (no session.start()).
    const firegrid = yield* Firegrid
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey,
      runtime: launchConfigToPublicRuntimeIntent(runConfig),
      createdBy: startCreatedBy,
    })
    // tf-2osu: no explicit readiness wait — appendRuntimeIngress owns a
    // bounded "context materialized" barrier internally.
    const initialPrompt = runConfigToIngressRequest(runConfig, session.contextId)
    if (initialPrompt !== undefined) {
      yield* appendRuntimeIngress(initialPrompt)
    }
    yield* printReadyRecord({
      address,
      config,
      contextId: session.contextId,
      durableStreams,
    })
  })

const hostMcpLayer = (
  durableStreams: DurableStreamsEndpoint,
  config: StartConfig,
): Layer.Layer<HttpServer.HttpServer, unknown, never> =>
  {
    const headers = durableTableHeadersFromEnv()
    // The CLI composes the host in-process, then layers the client-sdk
    // `Firegrid` service over it. `FiregridLive` shares the host's
    // namespace-scoped control plane; synchronous execution uses
    // host-sdk `startRuntime`.
    // FiregridLive consumes FiregridConfig (Durable Streams endpoint +
    // namespace) and the host's RuntimeControlPlaneTable. The CLI process
    // owns the durable endpoint, so it supplies the client config from the
    // same values the host layer is built with.
    const clientConfigLayer = Layer.succeed(FiregridConfig, {
      durableStreamsBaseUrl: durableStreams.baseUrl,
      namespace: config.namespace,
      ...(headers === undefined ? {} : { headers }),
    })
    const layer = FiregridMcpServerLayer({
      host: config.mcpHost,
      port: config.mcpPort,
      path: ensurePathInput(config.mcpPath),
    }).pipe(
      Layer.provideMerge(FiregridLive.pipe(Layer.provide(clientConfigLayer))),
      Layer.provideMerge(firegridLocalHostLayer(
        durableStreams,
        config.namespace,
        config.runConfig,
        headers,
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
      const externalKey = cliExternalKey("run")
      // TFIND-048: express the URL-less marker; the in-process host
      // injects the concrete contextId-scoped URL at start. No
      // pre-`createOrLoad` injection, no contextId pre-derivation.
      return yield* executeRun(
        withRuntimeContextMcpMarker(config),
        externalKey,
      ).pipe(
        Effect.provide(context),
      )
    }),
  )

const acpRuntimeIntent = (
  config: LaunchConfig,
  request: AcpStdioSessionRuntimeRequest,
) =>
  // firegrid-zed-acp-stdio-external-agent.ACP_STDIO_EDGE.5
  launchConfigToPublicRuntimeIntent(withRuntimeContextMcpMarker({
    ...config,
    ...(config.cwd === undefined ? { cwd: request.request.cwd } : {}),
  }))

const processInputStream = (): ReadableStream<Uint8Array> =>
  Readable.toWeb(globalThis.process.stdin) as ReadableStream<Uint8Array>

const processOutputStream = (): WritableStream<Uint8Array> =>
  Writable.toWeb(globalThis.process.stdout) as WritableStream<Uint8Array>

const hostAcpLayer = (
  durableStreams: DurableStreamsEndpoint,
  config: AcpConfig,
) => {
  const headers = durableTableHeadersFromEnv()
  const host = firegridLocalHostLayer(
    durableStreams,
    config.namespace,
    config.runConfig,
    headers,
  )
  const acpEdge = AcpStdioEdgeLive({
    input: processInputStream(),
    output: processOutputStream(),
    runtime: request => acpRuntimeIntent(config.runConfig, request),
  })
  // firegrid-zed-acp-stdio-external-agent.CLI_HELPER.3
  // firegrid-zed-acp-stdio-external-agent.MCP_BOUNDARY.4
  const mcpServer = Layer.discard(
    FiregridMcpServerLayer({
      host: defaultMcpHost,
      port: defaultMcpPort,
      path: ensurePathInput(defaultMcpPath),
    }),
  )
  const base = Layer.mergeAll(acpEdge, mcpServer).pipe(Layer.provideMerge(host))
  if (config.otelDestination === undefined) return base
  return base.pipe(
    Layer.provideMerge(
      // firegrid-zed-acp-stdio-external-agent.CLI_HELPER.4
      FiregridOtelLive({
        resource: {
          serviceName: "firegrid-acp",
          attributes: {
            "firegrid.namespace": config.namespace,
            "firegrid.durable_streams.base_url": durableStreams.baseUrl,
            "firegrid.process.role": "firegrid-acp",
          },
        },
        destination: config.otelDestination,
      }),
    ),
  )
}

const runAcpStdio = (
  durableStreams: DurableStreamsEndpoint,
  config: AcpConfig,
) =>
  Effect.scoped(
    Effect.gen(function*() {
      const context = yield* Layer.build(hostAcpLayer(durableStreams, config))
      const edge = Context.get(context, AcpStdioEdge)
      yield* edge.closed
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
  pnpm firegrid -- acp --agent codex-acp --agent-protocol acp -- npx -y @zed-industries/codex-acp@0.14.0
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

const acpHelp = `Start Firegrid as a long-running ACP stdio agent.

The command reserves stdout for ACP JSON-RPC frames and routes ACP newSession
and prompt requests into Firegrid host-plane channel routes.

Tracing is quiet by default. Use --otel-file or FIREGRID_OTEL_FILE to append
ended spans as JSONL without writing diagnostics to stdout. A relative
--otel-file resolves against --cwd when supplied (else the process cwd), so
under an editor like Zed pass --cwd "$PWD" (or an absolute --otel-file) to pin
the trace to your repo. The resolved absolute path is printed to stderr.

Examples:
  pnpm firegrid -- acp --agent codex-acp --agent-protocol acp -- npx -y @zed-industries/codex-acp@0.14.0
  pnpm firegrid -- acp --otel-file .firegrid/acp-trace.jsonl --cwd "$PWD" -- node agent.mjs`

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
const acpOtelFileOption = Options.text("otel-file").pipe(
  Options.withPseudoName("PATH"),
  Options.withDescription(
    "Append ACP host-process Effect spans as JSONL to PATH. Equivalent env: FIREGRID_OTEL_FILE.",
  ),
  Options.optional,
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
      return yield* Layer.launch(hostAndMcpLayer(durableStreams, config))
    }).pipe(Effect.scoped),
).pipe(Command.withDescription(startHelp))

const acpCommand = Command.make(
  "acp",
  {
    namespace: namespaceOption,
    agent: agentOption,
    agentProtocol: agentProtocolOption,
    cwd: cwdOption,
    secretEnv: secretEnvOption,
    otelFile: acpOtelFileOption,
    agentArgv: runArgv,
  },
  ({ agent, agentArgv, agentProtocol, cwd, namespace, otelFile, secretEnv }) =>
    Effect.gen(function*() {
      const raw = yield* rawRunConfigFromCli({
        agentArgv,
        agent,
        agentProtocol,
        cwd,
        prompt: Option.none(),
        secretEnv,
        allowEmptyAgentArgv: false,
      })
      const runConfig = yield* decodeCliRunConfig(raw, "firegrid acp")
      const durableStreams = yield* durableStreamsEndpoint
      const namespaceFromEnv = globalThis.process.env["FIREGRID_RUNTIME_NAMESPACE"]
      const cliFilePath = Option.getOrUndefined(otelFile)
      // tf-r1gz: a RELATIVE --otel-file (e.g. the documented
      // `.firegrid/acp-trace.jsonl`) used to resolve against the firegrid
      // PROCESS cwd. Under Zed the agent is launched from Zed's own cwd, not
      // the repo, so the trace silently landed at <zed-cwd>/.firegrid/... and
      // never appeared where operators looked. Pass the operator-supplied
      // --cwd (the project root the documented config pairs it with), else the
      // process cwd, as the resolution base so the resolver pins the trace to
      // an absolute, repo-correct path. Announce it on stderr (stdout stays
      // reserved for ACP JSON-RPC frames) so the location is never a guess.
      // firegrid-zed-acp-stdio-external-agent.CLI_HELPER.4
      const otelDestination = resolveFiregridOtelFileDestination({
        ...(cliFilePath === undefined ? {} : { filePath: cliFilePath }),
        env: globalThis.process.env,
        baseDir: Option.getOrUndefined(cwd) ?? globalThis.process.cwd(),
      })
      // Announce the exporter that will ACTUALLY run. OTEL_EXPORTER_OTLP_ENDPOINT
      // takes precedence over the file destination in FiregridOtelLive, so a
      // file announcement here would lie (and recreate the "trace file never
      // appears" confusion) whenever OTLP is configured.
      const activeOtelExporter = resolveFiregridOtelActiveExporter({
        destination: otelDestination,
        env: globalThis.process.env,
      })
      if (activeOtelExporter._tag === "file") {
        // tf-3718: fail loud at startup if the trace file destination is not
        // writable, instead of an opaque defect when the OTel layer is built.
        const writability = checkFiregridOtelFileWritable(activeOtelExporter.filePath)
        if (writability._tag === "unwritable") {
          return yield* usageError(
            `firegrid acp: cannot write OTEL trace file ${activeOtelExporter.filePath}: ${writability.reason}`,
          )
        }
        yield* Console.error(
          `firegrid acp: writing OTEL spans to ${activeOtelExporter.filePath}`,
        )
      } else if (activeOtelExporter._tag === "otlp") {
        const ignoredFile = otelDestination !== undefined && otelDestination._tag === "file"
          ? ` (--otel-file ${otelDestination.filePath} is ignored while OTEL_EXPORTER_OTLP_ENDPOINT is set)`
          : ""
        yield* Console.error(
          `firegrid acp: exporting OTEL spans to OTLP endpoint ${activeOtelExporter.endpoint}${ignoredFile}`,
        )
      }
      const config: AcpConfig = {
        namespace: Option.getOrElse(namespace, () =>
          namespaceFromEnv === undefined || namespaceFromEnv.length === 0
            ? defaultNamespace
            : namespaceFromEnv),
        runConfig,
        ...(otelDestination === undefined ? {} : { otelDestination }),
      }
      yield* runAcpStdio(durableStreams, config)
    }).pipe(Effect.scoped),
).pipe(Command.withDescription(acpHelp))

const rootCommand = Command.make("firegrid").pipe(
  Command.withDescription(rootHelp),
  Command.withSubcommands([runCommand, startCommand, acpCommand]),
)

const cli = Command.run(rootCommand, {
  name: "Firegrid CLI",
  version: "0.0.0",
})

const program = cli(globalThis.process.argv).pipe(
  Effect.provide(NodeContext.layer),
  // @effect/cli `Command.run` handles command-handler failures
  // (FiregridCliUsageError / FiregridRunError) and renders/exits for them,
  // so the top-level error channel is already `never` here — typed
  // `catchTag`s would be impossible. A single `catchAllCause` owns the
  // top-level defect/interrupt exit path.
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
    onSuccess: () => onExit(Number(globalThis.process.exitCode ?? 0)),
    onFailure: (cause) => onExit(Cause.isInterruptedOnly(cause) ? 0 : 1),
  })
}

// Localized final-boundary cast (firegrid-host-sdk.PACKAGE_GRAPH.5 review
// note): the in-process host layer really does provide Firegrid plus
// host-owned runtime services at runtime, but the
// pre-existing `as Layer.Layer<HttpServer.HttpServer, ...>` host-composition
// casts erase those services from the static success type, so the requirement
// is discharged at runtime but not visible to the type. Keep the cast here at
// the runMain boundary rather than widening the host/client composition.
NodeRuntime.runMain(program as Effect.Effect<unknown, never, never>, {
  disableErrorReporting: true,
  teardown,
})
