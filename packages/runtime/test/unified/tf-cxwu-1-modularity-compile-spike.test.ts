/**
 * tf-cxwu.1 — §12 modularity compile-spike (the GATE for the type-driven
 * composition target). Firegrid Composition SDD §10 step 0 / §12 Seam 1+2 /
 * "Modularity acceptance test".
 *
 * WHAT THIS VALIDATES — **provide-order requirement closure** (Seam 2), NOT
 * merely DAG-ness. A green DAG diagram is not a passing spike: a DAG still
 * fails to compile if a requirement is introduced *after* its satisfier in a
 * plain `provide` chain. The spike pins the exact provide expression and
 * proves Prod and Sim are the SAME constructor differing only by **which
 * adapter is passed and which backend Live is provided** — both `Layer.launch`
 * with `R = never` and no `as`-cast laundering `E` or `R`.
 *
 * The delta from the prior tf-0awo.18 compile-spike: that spike built the floor
 * directly from `spec.durableStreamsBaseUrl` (no hole). This spike makes the
 * floor the single `DurableStreams` *hole* (Seam 1) reaching through BOTH the
 * interior adapter and the upper layers, closed only by the backend Live at the
 * two call sites.
 *
 * firegrid-runtime-host-modularity.VALIDATION.1
 */

import { IdGenerator } from "@effect/ai"
import { DurableStreamTestServer } from "@durable-streams/server"
import {
  durableStreamUrl,
  DurableStreams,
  DurableStreamsLive,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  StreamName,
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
  composeFiregridRuntimeWithFloor,
  FiregridRuntimeContextMcpBaseUrlLive,
  ProductionCodecAdapterLive,
  RuntimeContextSessionAdapter,
  UnifiedTable,
  type FiregridRuntimeContextMcpBaseUrl,
  type RuntimeContextSessionAdapterService,
} from "../../src/unified/index.ts"

// The §12 spec no longer carries `durableStreamsBaseUrl` — URL arithmetic lives
// only in the `DurableStreams` Live (Seam 1). The constructor's spec is the
// host-identity/namespace residue.
interface FiregridRuntimeSpec {
  readonly namespace: string
}

// ── Seam 1 — the §12 floor consumes the `DurableStreams` *hole* ──────────────
// Compare to tf-0awo.18's `runtimeProvideFloor(spec)`, which resolved URLs from
// `spec.durableStreamsBaseUrl`. Here the floor `yield*`s `DurableStreams`, so
// its R-channel is `DurableStreams` and no `contextId`-parameterized stream
// builder exists to call — the per-context output URL is unconstructible.
const durableStreamsFloor = Layer.unwrapEffect(
  Effect.gen(function*() {
    const ds = yield* DurableStreams
    return Layer.mergeAll(
      RuntimeControlPlaneTable.layer({ streamOptions: ds.streamOptions(StreamName.ControlPlane) }),
      RuntimeOutputTable.layer({ streamOptions: ds.streamOptions(StreamName.Output) }),
      UnifiedTable.layer({ streamOptions: ds.streamOptions(StreamName.Unified) }),
      DurableStreamsWorkflowEngine.layer({ streamUrl: ds.streamOptions(StreamName.Engine).url }),
      FiregridRuntimeContextMcpBaseUrlLive,
    )
  }),
)

// ── the two-line §12 constructor — floor is the DurableStreams hole ──────────
const FiregridRuntimeV12 = (
  spec: FiregridRuntimeSpec,
  adapter: Layer.Layer<
    RuntimeContextSessionAdapter,
    never,
    RuntimeControlPlaneTable | RuntimeOutputTable | FiregridRuntimeContextMcpBaseUrl
  >,
) => composeFiregridRuntimeWithFloor(spec, adapter, durableStreamsFloor)

// ── Sim adapter (the swap unit — Seam 2) ─────────────────────────────────────
const simAdapterService: RuntimeContextSessionAdapterService = {
  startOrAttach: (_contextId, _attempt) => Effect.void,
  send: (_contextId, _attempt, _input) => Effect.void,
  deregister: (_contextId) => Effect.void,
}
const SimAdapter = Layer.succeed(RuntimeContextSessionAdapter, simAdapterService)

// ── Prod adapter (`ProductionCodecAdapterLive` over a stub sandbox leaf) ─────
const runningSandbox = (config: SandboxConfig): Sandbox => ({
  id: "modularity-spike-sandbox",
  provider: "modularity-spike",
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
  stdout: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
  stderr: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
  exit: Effect.succeed({ exitCode: 0 }),
})
const stubSandboxProvider: SandboxProviderService = {
  name: "modularity-spike",
  capabilities: defaultCapabilities,
  create: (config) => Effect.succeed(runningSandbox(config)),
  getOrCreate: (config) => Effect.succeed(runningSandbox(config)),
  find: (_labels) => Effect.void.pipe(Effect.as(undefined as Sandbox | undefined)),
  execute: (_sandbox, _command: SandboxCommand) => Effect.succeed(executionResult),
  executeMany: (_sandbox, commands) => Effect.succeed(commands.map(() => executionResult)),
  stream: (_sandbox, _command): Stream.Stream<ProcessOutputChunk, never> => Stream.empty,
  openBytePipe: (_sandbox, _command) => Effect.succeed(stubByteStream()),
  upload: (_sandbox, _localPath, _remotePath) => Effect.void,
  download: (_sandbox, _remotePath, _localPath) => Effect.void,
  destroy: (_sandbox) => Effect.succeed(true),
}

const ContextResolverFromControlPlaneLive: Layer.Layer<
  ContextResolverTag,
  never,
  RuntimeControlPlaneTable
> = Layer.effect(
  ContextResolverTag,
  Effect.context<RuntimeControlPlaneTable>().pipe(
    Effect.map((context): ContextResolver => {
      const control = Context.get(context, RuntimeControlPlaneTable)
      return { resolve: (contextId) => control.contexts.get(contextId) }
    }),
  ),
)
const CodecOutputJournalFromOutputLive: Layer.Layer<
  CodecOutputJournalTag,
  never,
  RuntimeOutputTable
> = Layer.effect(
  CodecOutputJournalTag,
  Effect.context<RuntimeOutputTable>().pipe(
    Effect.map((context): CodecOutputJournal => {
      const output = Context.get(context, RuntimeOutputTable)
      return { append: (row) => output.events.insertOrGet(row).pipe(Effect.asVoid) }
    }),
  ),
)

const prodAdapterSupport = SandboxProvider.layer(stubSandboxProvider).pipe(
  Layer.merge(Layer.succeed(IdGenerator.IdGenerator, IdGenerator.defaultIdGenerator)),
  Layer.merge(ContextResolverFromControlPlaneLive),
  Layer.merge(CodecOutputJournalFromOutputLive),
  Layer.merge(RuntimeEnvResolverPolicy.denyAll),
  Layer.orDie,
)

// Prod adapter R = the substrate tags + MCP base — exactly the
// `RuntimeContextSessionAdapter` shape the constructor's positional arg accepts.
const ProdAdapter = ProductionCodecAdapterLive.pipe(Layer.provide(prodAdapterSupport))

// ── Sim-side embedded backend Live (Seam 1 `makeInMemoryBackend`) ────────────
// Lives HERE, not in `protocol`: it owns a server lifecycle and must not pull a
// transport server into browser-safe `protocol`. The Live is self-contained
// (in-process server, no external config), so it closes the `DurableStreams`
// hole with R = never.
const DurableStreamsEmbedded: Layer.Layer<DurableStreams> = Layer.scoped(
  DurableStreams,
  Effect.acquireRelease(
    Effect.promise(async () => {
      const server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
      const baseUrl = await server.start()
      return { server, baseUrl }
    }),
    ({ server }) => Effect.promise(() => server.stop()),
  ).pipe(
    Effect.map(({ baseUrl }) =>
      DurableStreams.of({
        streamOptions: (name) => ({
          url: durableStreamUrl(baseUrl, `embedded.firegrid.${name}`),
          contentType: "application/json",
        }),
      }),
    ),
  ),
)

// ─────────────────────────────────────────────────────────────────────────────
// TYPE-LEVEL ACCEPTANCE — the keystone (§2): `R = never` is the launchability
// gate, with no `as`-cast laundering `E` or `R`. If any of these annotations
// require a residual requirement the floor/backend doesn't satisfy, the spike
// has FAILED and that requirement is the finding.
// ─────────────────────────────────────────────────────────────────────────────

// (1) The bare V12 runtime, floor still a hole: R = DurableStreams only.
const _assertRuntimeHoleIsDurableStreamsOnly = (
  spec: FiregridRuntimeSpec,
): Layer.Layer<unknown, unknown, DurableStreams> => FiregridRuntimeV12(spec, SimAdapter)
void _assertRuntimeHoleIsDurableStreamsOnly

// (2) Prod: provide the configured backend Live → R = never.
const _assertProdClosesToNever = (
  spec: FiregridRuntimeSpec,
  cfg: { readonly baseUrl: string; readonly namespace: string },
): Layer.Layer<unknown, unknown, never> =>
  FiregridRuntimeV12(spec, ProdAdapter).pipe(
    Layer.provide(DurableStreamsLive.configuredWith(cfg)),
  )
void _assertProdClosesToNever

// (3) Sim: provide the embedded backend Live → R = never.
const _assertSimClosesToNever = (
  spec: FiregridRuntimeSpec,
): Layer.Layer<unknown, unknown, never> =>
  FiregridRuntimeV12(spec, SimAdapter).pipe(Layer.provide(DurableStreamsEmbedded))
void _assertSimClosesToNever

// (4) Both are `Layer.launch`-able with R = never (the acceptance gate).
const _assertProdLaunchIsTotal = (
  spec: FiregridRuntimeSpec,
  cfg: { readonly baseUrl: string; readonly namespace: string },
): Effect.Effect<never, unknown, never> =>
  Layer.launch(
    FiregridRuntimeV12(spec, ProdAdapter).pipe(
      Layer.provide(DurableStreamsLive.configuredWith(cfg)),
    ),
  )
void _assertProdLaunchIsTotal

const _assertSimLaunchIsTotal = (
  spec: FiregridRuntimeSpec,
): Effect.Effect<never, unknown, never> =>
  Layer.launch(
    FiregridRuntimeV12(spec, SimAdapter).pipe(Layer.provide(DurableStreamsEmbedded)),
  )
void _assertSimLaunchIsTotal

// ─────────────────────────────────────────────────────────────────────────────
// RUNTIME ACCEPTANCE — the two-line Prod/Sim both actually launch (build).
// ─────────────────────────────────────────────────────────────────────────────
describe("tf-cxwu.1 §12 modularity compile-spike — provide-order closure", () => {
  let server: DurableStreamTestServer
  let baseUrl: string

  const assertLaunches = <ROut, E>(
    layer: Layer.Layer<ROut, E, never>,
  ): Effect.Effect<void, E, never> =>
    Effect.raceFirst(Layer.launch(layer), Effect.sleep("50 millis"))

  beforeAll(async () => {
    server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
    baseUrl = await server.start()
  })
  afterAll(async () => {
    await server.stop()
  })

  it("launches Prod and Sim from the SAME constructor — differ only by adapter + backend Live", async () => {
    const spec = { namespace: "tf-cxwu-1-modularity" }

    // Prod: ProdAdapter + configured backend (real test server).
    const Prod = FiregridRuntimeV12(spec, ProdAdapter).pipe(
      Layer.provide(
        DurableStreamsLive.configuredWith({ baseUrl, namespace: spec.namespace }),
      ),
    )
    // Sim: SimAdapter + embedded in-memory backend (self-contained server).
    const Sim = FiregridRuntimeV12(
      { namespace: "tf-cxwu-1-modularity-sim" },
      SimAdapter,
    ).pipe(Layer.provide(DurableStreamsEmbedded))

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          yield* assertLaunches(Prod)
          yield* assertLaunches(Sim)
        }),
      ),
    )

    expect(baseUrl).toMatch(/^http:\/\//)
  })
})
