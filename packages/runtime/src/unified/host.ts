/**
 * FiregridHost — the unified production composition factory.
 *
 * One call builds the substrate + workflows + channels + observer +
 * recovery into a single Layer that satisfies the production Tags a
 * `@firegrid/client-sdk` consumer needs.
 *
 * Per SDD_FIREGRID_UNIFIED_PRODUCTION_WIRING §F: factory shape with
 * documented escape hatches. The 14-piece composition lives here;
 * users provide an adapter (required) plus optional overrides; standard
 * Effect `Layer.provide` pattern overrides any individual Tag.
 *
 * What this Layer provides (outward):
 *
 *   - `RuntimeControlPlaneTable` — protocol-owned durable substrate
 *   - `RuntimeOutputTable` — durable journal for agent outputs
 *   - `SignalTable` — unified signal primitive backing store
 *   - `UnifiedTable` — UI-renderable row families (permissions etc.)
 *   - All `HostPromptChannel`/`SessionPromptChannel`/etc Tags via
 *     `UnifiedSignalingChannelBindingsLive` (overridable)
 *   - `WorkflowEngine` + the six workflow Lives
 *   - `JournalObserverLive` — daemon translating journal rows into
 *     sibling workflow executions
 *
 * What it requires (R-channel): never. The factory is self-contained.
 *
 * Escape hatch example: provide a custom HostPromptChannel binding
 *
 *     FiregridHost({ adapter, durableStreamsBaseUrl, namespace }).pipe(
 *       Layer.provide(MyCustomHostPromptChannelLive)
 *     )
 *
 * Phase E deferred: production codec adapter Lives wrapping
 * `sources/codecs/{acp,stdio-jsonl}`. Today users provide their own
 * `RuntimeContextSessionAdapter` Live; tests provide their own stand-ins
 * from test helper modules.
 */

import { IdGenerator } from "@effect/ai"
import { NodeContext } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import type { DurableTableHeaders } from "effect-durable-operators"
import {
  durableStreamUrl,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  runtimeControlPlaneStreamUrl,
  runtimeOutputStreamUrl,
} from "@firegrid/protocol/launch"
import { DurableStreamsWorkflowEngine } from "../engine/durable-streams-workflow-engine.ts"
import {
  LocalProcessSandboxProvider,
  RuntimeEnvResolverPolicy,
  type SandboxProvider,
} from "../sources/sandbox/index.ts"
import { type RuntimeContextSessionAdapter } from "./adapter.ts"
import {
  ProductionCodecAdapterLive,
} from "./codec-adapter.ts"
import {
  FiregridRuntimeContextMcpBaseUrlLive,
  type FiregridRuntimeContextMcpBaseUrl,
} from "./mcp-host/runtime-context-mcp-base-url.ts"
import {
  CodecOutputJournalFromRuntimeOutputTableLive,
  ContextResolverFromControlPlaneTableLive,
} from "../tables/codec-adapter-providers.ts"
import type {
  CodecOutputJournalTag,
  ContextResolverTag,
} from "../tables/codec-adapter-tags.ts"
import { buildCurrentHostSessionLayer } from "./host-identity.ts"
import { UnifiedTable } from "./tables.ts"
import {
  UnifiedSignalingChannelBindingsLive,
} from "./channel-bindings.ts"
import {
  RuntimeContextSessionWorkflowLayer,
} from "./subscribers/runtime-context.ts"
import {
  buildPermissionRoundtripLayer,
  buildToolDispatchLayer,
  type ToolExecutor,
  makeToolExecutor,
} from "./subscribers/permission-and-tool.ts"
import {
  buildPeerEventObserverLayer,
  buildScheduledPromptLayer,
} from "./subscribers/scheduled-webhook-peer.ts"
import { JournalObserverLive } from "./observers.ts"
import { HostControlChannelBindingsLive } from "../channels/host-control.ts"

export interface FiregridRuntimeSpec {
  /** Durable-streams base URL (e.g. `http://durable-streams:4437`). */
  readonly durableStreamsBaseUrl: string
  /** Namespace prefix for all this host's durable streams. */
  readonly namespace: string
  /** Optional auth headers for durable-streams writes/reads. */
  readonly headers?: DurableTableHeaders
  /**
   * Optional explicit host id (single dot-free segment). Default:
   * derived from the namespace (`${namespace}-host` with `.` → `_`).
   */
  readonly hostId?: string
  /**
   * Optional override for the tool executor. Default echoes the input —
   * suitable for sims, not production. Production hosts MUST supply a
   * real executor Layer.
   */
  readonly toolExecutor?: Layer.Layer<ToolExecutor>
  /**
   * Optional override for the env-binding resolver policy. Used by
   * `ProductionCodecAdapterLive` to resolve `RuntimeEnvBinding.ref`
   * pairs to env values before spawning the agent process. Default is
   * `RuntimeEnvResolverPolicy.denyAll` — any context that declares
   * envBindings fails fast at startOrAttach unless this override
   * supplies a policy that authorizes the pair.
   *
   * For production, compose `RuntimeEnvResolverPolicy.withPolicy({
   *   authorizedBindings: [["MY_VAR", "HOST_MY_VAR"]],
   *   lookupEnv: (name) => process.env[name],
   * })` to allow named (binding, host-env-var) pairs.
   */
  readonly envPolicy?: Layer.Layer<RuntimeEnvResolverPolicy>
}

export type FiregridHostOptionsBase = FiregridRuntimeSpec

export interface FiregridHostOptionsWithAdapter extends FiregridHostOptionsBase {
  /**
   * Compose the session adapter Layer yourself. Required for sims or
   * non-ACP hosts; use the `codec: "acp"` sugar option below for the
   * default production path. Must be fully provided (R → never) so the
   * composed host stays launchable; an `any` R-channel here would let an
   * under-provided adapter leak a hidden requirement into the host (tf-0awo.21 §6).
   */
  readonly adapter: Layer.Layer<RuntimeContextSessionAdapter, never, never>
}

export interface FiregridHostOptionsWithCodecSugar extends FiregridHostOptionsBase {
  /**
   * Sugar option — composes the canonical production stack for the
   * named codec:
   *
   *   - `ProductionCodecAdapterLive` (codec wrapper)
   *   - `LocalProcessSandboxProvider` + `NodeContext.layer`
   *   - `IdGenerator.defaultIdGenerator`
   *   - `ContextResolverFromControlPlaneTableLive`
   *   - `RuntimeEnvResolverPolicy.denyAll` (override for env bindings)
   *
   * The codec is selected at session.startOrAttach via the resolved
   * context's `runtime.config.agentProtocol` field. Today only `"acp"`
   * is supported as a sugar option; `"stdio-jsonl"` works through the
   * same adapter for raw protocols.
   */
  readonly codec: "acp"
}

export type FiregridHostOptions =
  | FiregridHostOptionsWithAdapter
  | FiregridHostOptionsWithCodecSugar

export type FiregridRuntimeAdapterLayer = Layer.Layer<
  RuntimeContextSessionAdapter,
  never,
  RuntimeControlPlaneTable | RuntimeOutputTable | FiregridRuntimeContextMcpBaseUrl
>

const hasAdapter = (
  options: FiregridHostOptions,
): options is FiregridHostOptionsWithAdapter => "adapter" in options

export const defaultProductionAdapterLayer = (
  envPolicy: Layer.Layer<RuntimeEnvResolverPolicy> = RuntimeEnvResolverPolicy.denyAll,
): FiregridRuntimeAdapterLayer => {
  const sandbox: Layer.Layer<SandboxProvider> = LocalProcessSandboxProvider.layer().pipe(
    Layer.provide(NodeContext.layer),
  )
  const idGenerator: Layer.Layer<IdGenerator.IdGenerator> = Layer.succeed(
    IdGenerator.IdGenerator,
    IdGenerator.defaultIdGenerator,
  )
  const support = ContextResolverFromControlPlaneTableLive.pipe(
    Layer.provideMerge(CodecOutputJournalFromRuntimeOutputTableLive),
    Layer.provideMerge(sandbox),
    Layer.provideMerge(idGenerator),
    Layer.provideMerge(envPolicy),
  ) as Layer.Layer<
    | SandboxProvider
    | IdGenerator.IdGenerator
    | ContextResolverTag
    | CodecOutputJournalTag
    | RuntimeEnvResolverPolicy,
    never,
    RuntimeControlPlaneTable | RuntimeOutputTable
  >
  return Layer.provide(ProductionCodecAdapterLive, support)
}

const jsonStreamOptions = (
  url: string,
  headers: DurableTableHeaders | undefined,
) => ({
  url,
  contentType: "application/json",
  ...(headers === undefined ? {} : { headers }),
})

const tableLayer = (options: FiregridRuntimeSpec) =>
  Layer.mergeAll(
    RuntimeControlPlaneTable.layer({
      streamOptions: jsonStreamOptions(
        runtimeControlPlaneStreamUrl({
          baseUrl: options.durableStreamsBaseUrl,
          namespace: options.namespace,
        }),
        options.headers,
      ),
    }),
    RuntimeOutputTable.layer({
      streamOptions: jsonStreamOptions(
        runtimeOutputStreamUrl({
          baseUrl: options.durableStreamsBaseUrl,
          namespace: options.namespace,
        }),
        options.headers,
      ),
    }),
    UnifiedTable.layer({
      streamOptions: {
        url: durableStreamUrl(
          options.durableStreamsBaseUrl,
          `${options.namespace}.firegrid.unified`,
        ),
        contentType: "application/json",
        ...(options.headers === undefined ? {} : { headers: options.headers }),
      },
    }),
  )

const engineLayer = (options: FiregridRuntimeSpec) =>
  DurableStreamsWorkflowEngine.layer({
    streamUrl: durableStreamUrl(
      options.durableStreamsBaseUrl,
      `${options.namespace}.firegrid.engine`,
    ),
  })

const runtimeProvideFloor = (spec: FiregridRuntimeSpec) =>
  Layer.mergeAll(
    tableLayer(spec),
    engineLayer(spec),
    FiregridRuntimeContextMcpBaseUrlLive,
  )

// tf-k00i: the parked-body signal-recovery sweep is GONE — there is no bespoke
// `SignalTable` mailbox to recover, and the per-event handler creates its
// execution per input via `execute({discard})` (no input-before-start arm to
// replay). The await-once sibling relays (permission/tool/webhook/peer) now use
// `@effect/workflow` `DurableDeferred`, whose result rows the engine persists
// (`deferredResult`/`deferredDone`). TODO(tf-k00i follow-up): the engine's
// startup recovery (`recoverPendingClockWakeups`, engine-runtime.ts:149) does
// not yet KIND-AWARE-recover non-clock deferred-waits across a host restart;
// the in-process real-path sims do not exercise host-restart recovery, so this
// is left as a scoped engine follow-up rather than gold-plated here.

/**
 * The production composition factory. Returns a single Layer that
 * satisfies the substrate + channel + workflow Tags a Firegrid host
 * needs. The R-channel is `never` — composition is self-contained.
 *
 * Override any individual Tag via `.pipe(Layer.provide(MyLive))`.
 */
export const FiregridRuntime = (
  spec: FiregridRuntimeSpec,
  adapter: FiregridRuntimeAdapterLayer,
) => {
  const toolExecutorEffect = makeToolExecutor((p) =>
    JSON.stringify({ tool: p.toolName, input: JSON.parse(p.inputJson) as unknown }),
  )

  const adapterLayer = adapter.pipe(
    Layer.provide(runtimeProvideFloor(spec)),
    Layer.orDie,
  )
  const hostSessionLayer = buildCurrentHostSessionLayer({
    namespace: spec.namespace,
    ...(spec.hostId === undefined ? {} : { hostId: spec.hostId }),
  })

  return Layer.unwrapEffect(
    Effect.gen(function*() {
      const toolExecutor = yield* toolExecutorEffect
      const workflowLayers = Layer.mergeAll(
        RuntimeContextSessionWorkflowLayer.pipe(Layer.provide(adapterLayer)),
        buildPermissionRoundtripLayer(),
        buildToolDispatchLayer(toolExecutor),
        buildScheduledPromptLayer(),
        buildPeerEventObserverLayer(),
      )
      // `UnifiedSignalingChannelBindingsLive` is composed via `provideMerge`
      // (not as a parallel `Layer.mergeAll` sibling) so the els does not flag a
      // parallel cross-dependency on the input-delivery channel Tags; all Tags
      // remain provided outward.
      const channelsAndObserver = Layer.mergeAll(
        HostControlChannelBindingsLive,
        JournalObserverLive,
      ).pipe(Layer.provideMerge(UnifiedSignalingChannelBindingsLive))
      return workflowLayers.pipe(
        Layer.provideMerge(channelsAndObserver),
        Layer.provideMerge(runtimeProvideFloor(spec)),
        Layer.provideMerge(hostSessionLayer),
      )
    }),
  )
}

/**
 * Backward-compatible wrapper for existing call sites. New code should prefer
 * `FiregridRuntime(spec, adapter)` so the adapter/floor boundary is explicit.
 */
export const FiregridHost = (options: FiregridHostOptions) =>
  FiregridRuntime(
    options,
    hasAdapter(options)
      ? options.adapter
      : defaultProductionAdapterLayer(options.envPolicy),
  )

// Re-export primitive layers for users wanting full control or
// overriding individual substrate pieces.
export {
  DurableStreamsWorkflowEngine,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  UnifiedTable,
}
export type { ToolExecutor }
