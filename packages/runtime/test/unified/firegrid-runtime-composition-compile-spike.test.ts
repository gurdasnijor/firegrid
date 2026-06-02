/**
 * Throwaway compile spike for tf-0awo.18.
 *
 * firegrid-runtime-host-modularity.VALIDATION.1
 */

import { IdGenerator } from "@effect/ai"
import { DurableStreamTestServer } from "@durable-streams/server"
import {
  durableStreamUrl,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  runtimeControlPlaneStreamUrl,
  runtimeOutputStreamUrl,
} from "@firegrid/protocol/launch"
import { Context, Effect, Layer, Stream } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DurableStreamsWorkflowEngine } from "../../src/engine/durable-streams-workflow-engine.ts"
import {
  defaultCapabilities,
  RuntimeEnvResolverPolicy,
  SandboxProvider,
  type ExecutionResult,
  type ProcessOutputChunk,
  type Sandbox,
  type SandboxConfig,
  type SandboxCommand,
  type SandboxProviderService,
} from "../../src/sources/sandbox/index.ts"
import {
  CodecOutputJournalTag,
  ContextResolverTag,
  type CodecOutputJournal,
  type ContextResolver,
} from "../../src/tables/codec-adapter-tags.ts"
import {
  FiregridHost,
  FiregridRuntimeContextMcpBaseUrlLive,
  ProductionCodecAdapterLive,
  RuntimeContextSessionAdapter,
  SignalTable,
  UnifiedTable,
  type FiregridRuntimeContextMcpBaseUrl,
  type RuntimeContextSessionAdapterService,
} from "../../src/unified/index.ts"

interface FiregridRuntimeSpec {
  readonly durableStreamsBaseUrl: string
  readonly namespace: string
}

const jsonStreamOptions = (url: string) => ({
  url,
  contentType: "application/json",
})

const durableStreamsFloor = (
  spec: FiregridRuntimeSpec,
) =>
  Layer.mergeAll(
    RuntimeControlPlaneTable.layer({
      streamOptions: jsonStreamOptions(
        runtimeControlPlaneStreamUrl({
          baseUrl: spec.durableStreamsBaseUrl,
          namespace: spec.namespace,
        }),
      ),
    }),
    RuntimeOutputTable.layer({
      streamOptions: jsonStreamOptions(
        runtimeOutputStreamUrl({
          baseUrl: spec.durableStreamsBaseUrl,
          namespace: spec.namespace,
        }),
      ),
    }),
    SignalTable.layer({
      streamOptions: jsonStreamOptions(
        durableStreamUrl(
          spec.durableStreamsBaseUrl,
          `${spec.namespace}.firegrid.signals`,
        ),
      ),
    }),
    UnifiedTable.layer({
      streamOptions: jsonStreamOptions(
        durableStreamUrl(
          spec.durableStreamsBaseUrl,
          `${spec.namespace}.firegrid.unified`,
        ),
      ),
    }),
    DurableStreamsWorkflowEngine.layer({
      streamUrl: durableStreamUrl(
        spec.durableStreamsBaseUrl,
        `${spec.namespace}.firegrid.engine`,
      ),
    }),
  )

const runtimeProvideFloor = (spec: FiregridRuntimeSpec) =>
  Layer.mergeAll(
    durableStreamsFloor(spec),
    FiregridRuntimeContextMcpBaseUrlLive,
  )

const runningSandbox = (config: SandboxConfig): Sandbox => ({
  id: "compile-spike-sandbox",
  provider: "compile-spike",
  state: "running",
  labels: config.labels ?? {},
  connectionInfo: {},
  metadata: {},
})

const executionResult: ExecutionResult = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  truncated: false,
  timedOut: false,
}

const stubByteStream = () => ({
  stdin: new WritableStream<Uint8Array>(),
  stdout: new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close()
    },
  }),
  stderr: new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close()
    },
  }),
  exit: Effect.succeed({ exitCode: 0 }),
})

const stubSandboxProvider: SandboxProviderService = {
  name: "compile-spike",
  capabilities: defaultCapabilities,
  create: (config) => Effect.succeed(runningSandbox(config)),
  getOrCreate: (config) => Effect.succeed(runningSandbox(config)),
  find: (_labels) => Effect.sync(() => undefined),
  execute: (_sandbox, _command: SandboxCommand) => Effect.succeed(executionResult),
  executeMany: (_sandbox, commands) =>
    Effect.succeed(commands.map(() => executionResult)),
  stream: (_sandbox, _command): Stream.Stream<ProcessOutputChunk, never> =>
    Stream.empty,
  openBytePipe: (_sandbox, _command) => Effect.succeed(stubByteStream()),
  upload: (_sandbox, _localPath, _remotePath) => Effect.void,
  download: (_sandbox, _remotePath, _localPath) => Effect.void,
  destroy: (_sandbox) => Effect.succeed(true),
}

const simAdapterService: RuntimeContextSessionAdapterService = {
  startOrAttach: (_contextId, _attempt) => Effect.void,
  send: (_contextId, _attempt, _input) => Effect.void,
  deregister: (_contextId) => Effect.void,
}

const SimAdapterLive = Layer.succeed(
  RuntimeContextSessionAdapter,
  simAdapterService,
)

const makeContextResolver: Effect.Effect<
  ContextResolver,
  never,
  RuntimeControlPlaneTable
> = Effect.context<RuntimeControlPlaneTable>().pipe(
  Effect.map((context): ContextResolver => {
    const control = Context.get(context, RuntimeControlPlaneTable)
    return {
      resolve: (contextId) => control.contexts.get(contextId),
    }
  }),
)

const ContextResolverFromDurableStreamsLive: Layer.Layer<
  ContextResolverTag,
  never,
  RuntimeControlPlaneTable
> = Layer.effect(ContextResolverTag, makeContextResolver)

const makeCodecOutputJournal: Effect.Effect<
  CodecOutputJournal,
  never,
  RuntimeOutputTable
> = Effect.context<RuntimeOutputTable>().pipe(
  Effect.map((context): CodecOutputJournal => {
    const output = Context.get(context, RuntimeOutputTable)
    return {
      append: (row) => output.events.insertOrGet(row).pipe(Effect.asVoid),
    }
  }),
)

const CodecOutputJournalFromDurableStreamsLive: Layer.Layer<
  CodecOutputJournalTag,
  never,
  RuntimeOutputTable
> = Layer.effect(CodecOutputJournalTag, makeCodecOutputJournal)

const productionCodecAdapterSupportLive: Layer.Layer<
  | SandboxProvider
  | IdGenerator.IdGenerator
  | ContextResolverTag
  | CodecOutputJournalTag
  | RuntimeEnvResolverPolicy,
  never,
  RuntimeControlPlaneTable | RuntimeOutputTable
> =
  SandboxProvider.layer(stubSandboxProvider).pipe(
    Layer.merge(
      Layer.succeed(IdGenerator.IdGenerator, IdGenerator.defaultIdGenerator),
    ),
    Layer.merge(ContextResolverFromDurableStreamsLive),
    Layer.merge(CodecOutputJournalFromDurableStreamsLive),
    Layer.merge(RuntimeEnvResolverPolicy.denyAll),
    Layer.orDie,
  )

type RuntimeAdapterLayer = Layer.Layer<
  RuntimeContextSessionAdapter,
  never,
  RuntimeControlPlaneTable | RuntimeOutputTable | FiregridRuntimeContextMcpBaseUrl
>

const ProductionCodecAdapterFromDurableStreamsLive: RuntimeAdapterLayer =
  ProductionCodecAdapterLive.pipe(
    Layer.provide(productionCodecAdapterSupportLive),
  )

const FiregridRuntime = (
  spec: FiregridRuntimeSpec,
  adapter: RuntimeAdapterLayer,
) => {
  const closedAdapter = adapter.pipe(
    Layer.provide(runtimeProvideFloor(spec)),
    Layer.orDie,
  )
  return FiregridHost({
    durableStreamsBaseUrl: spec.durableStreamsBaseUrl,
    namespace: spec.namespace,
    adapter: closedAdapter,
  })
}

const FiregridRuntimeProd = (spec: FiregridRuntimeSpec) =>
  FiregridRuntime(spec, ProductionCodecAdapterFromDurableStreamsLive)

const FiregridRuntimeSim = (spec: FiregridRuntimeSpec) =>
  FiregridRuntime(spec, SimAdapterLive)

const _assertProdAdapterClosesToDurableStreams: Layer.Layer<
  RuntimeContextSessionAdapter,
  never,
  RuntimeControlPlaneTable | RuntimeOutputTable | FiregridRuntimeContextMcpBaseUrl
> = ProductionCodecAdapterFromDurableStreamsLive
void _assertProdAdapterClosesToDurableStreams

const _assertProdRuntimeIsTotal = (
  spec: FiregridRuntimeSpec,
): Layer.Layer<unknown, unknown, never> => FiregridRuntimeProd(spec)
void _assertProdRuntimeIsTotal

const _assertSimRuntimeIsTotal = (
  spec: FiregridRuntimeSpec,
): Layer.Layer<unknown, unknown, never> => FiregridRuntimeSim(spec)
void _assertSimRuntimeIsTotal

const _assertProdLaunchIsTotal = (
  spec: FiregridRuntimeSpec,
): Effect.Effect<never, unknown, never> => Layer.launch(FiregridRuntimeProd(spec))
void _assertProdLaunchIsTotal

const _assertSimLaunchIsTotal = (
  spec: FiregridRuntimeSpec,
): Effect.Effect<never, unknown, never> => Layer.launch(FiregridRuntimeSim(spec))
void _assertSimLaunchIsTotal

describe("tf-0awo.18 FiregridRuntime composition compile spike", () => {
  let server: DurableStreamTestServer
  let baseUrl: string

  const assertLaunches = <ROut, E>(
    layer: Layer.Layer<ROut, E, never>,
  ): Effect.Effect<void, E, never> =>
    Effect.raceFirst(
      Layer.launch(layer),
      Effect.sleep("50 millis"),
    )

  beforeAll(async () => {
    server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
    baseUrl = await server.start()
  })

  afterAll(async () => {
    await server.stop()
  })

  it("launches the two-line production and sim constructors with R=never", async () => {
    const spec = {
      durableStreamsBaseUrl: baseUrl,
      namespace: "tf-0awo-18-compile-spike",
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          yield* assertLaunches(FiregridRuntimeProd(spec))
          yield* assertLaunches(FiregridRuntimeSim({
            ...spec,
            namespace: "tf-0awo-18-compile-spike-sim",
          }))
        }),
      ),
    )

    expect(baseUrl).toMatch(/^http:\/\//)
  })

  it("builds the production adapter against real durable-streams table services", async () => {
    const spec = {
      durableStreamsBaseUrl: baseUrl,
      namespace: "tf-0awo-18-adapter-substrate",
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const control = yield* RuntimeControlPlaneTable
          yield* control.contexts.get("missing-context")
          yield* assertLaunches(
            ProductionCodecAdapterFromDurableStreamsLive.pipe(
              Layer.provide(runtimeProvideFloor(spec)),
              Layer.orDie,
            ),
          )
        }).pipe(
          // Single merged provide (per §12 Seam 2: one floor, not chained
          // provides) — diagnostic-clean and order-robust.
          Effect.provide(
            Layer.merge(durableStreamsFloor(spec), FiregridRuntimeContextMcpBaseUrlLive),
          ),
        ),
      ),
    )
  })
})
