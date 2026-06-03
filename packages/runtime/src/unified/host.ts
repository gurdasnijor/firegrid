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
  DurableStreams,
  DurableStreamsLive,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  StreamName,
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
  /** Namespace prefix for all this host's durable streams. */
  readonly namespace: string
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

/**
 * Back-compat `FiregridHost` options — still thread the durable-streams base
 * URL the way pre-§12 callers expect. `FiregridHost` provides the
 * `DurableStreams` backend Live itself (from these fields) so its composed
 * Layer stays `R = never`, while the §12 `FiregridRuntime` constructor takes
 * the base URL out of the spec and leaves `DurableStreams` as a hole the caller
 * closes. (`misuse-resistance-footguns` F1 pins `durableStreamsBaseUrl` as
 * required here.)
 */
export interface FiregridHostOptionsBase extends FiregridRuntimeSpec {
  /** Durable-streams base URL (e.g. `http://durable-streams:4437`). */
  readonly durableStreamsBaseUrl: string
  /** Optional auth headers for durable-streams writes/reads. */
  readonly headers?: DurableTableHeaders
}

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

/**
 * §12 Seam 1 — the substrate floor CONSUMES the `DurableStreams` Tag (a leaf
 * hole) rather than building stream URLs from a `spec.durableStreamsBaseUrl`.
 * The table/engine `streamOptions` are sourced from
 * `DurableStreams.streamOptions(name)` over the closed `StreamName` set (no
 * `contextId` — a per-context output stream is unconstructible). McpEndpoint
 * (`FiregridRuntimeContextMcpBaseUrlLive`) stays a MEMBER of the merged floor —
 * the tf-cxwu.1 verdict's load-bearing rule: it is introduced and satisfied by
 * the same floor value, so the "introduced after its satisfier" provide-order
 * hazard never arises. The floor's R-channel is `DurableStreams`.
 */
const runtimeProvideFloor = Layer.unwrapEffect(
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

/** The Tag set / error channel a runtime floor provides. */
type RuntimeProvideFloorOut = Layer.Layer.Success<typeof runtimeProvideFloor>
type RuntimeProvideFloorErr = Layer.Layer.Error<typeof runtimeProvideFloor>

/**
 * The spec the floor-injectable constructor needs — strictly LESS than
 * `FiregridRuntimeSpec`. Once the floor is a `DurableStreams` hole (Seam 1),
 * `durableStreamsBaseUrl`/`headers` move out of the spec and into the backend
 * Live; the constructor body reads only the host-identity residue.
 */
export interface FiregridRuntimeFloorSpec {
  readonly namespace: string
  readonly hostId?: string
}

/**
 * The composition body, parameterized over the substrate **floor** — the only
 * thing that differs between the production self-contained host (floor built
 * from `spec`, `R = never`) and the §12 modularity target (floor is the
 * `DurableStreams` *hole*, `R = DurableStreams` until a backend Live is
 * provided). The floor is referenced in exactly two spots — under the adapter
 * (`Layer.provide`) and under the workflows (`Layer.provideMerge`) — so this is
 * the seam the modularity spike (tf-cxwu.1 / §10 step 0) exercises for
 * provide-order requirement closure: a single floor value satisfies *both*
 * the interior adapter and the upper layers, and its `R` propagates outward
 * once (deduped by Tag identity).
 */
const composeFiregridRuntimeWithFloor = <FloorR>(
  spec: FiregridRuntimeFloorSpec,
  adapter: FiregridRuntimeAdapterLayer,
  floor: Layer.Layer<RuntimeProvideFloorOut, RuntimeProvideFloorErr, FloorR>,
) => {
  const toolExecutorEffect = makeToolExecutor((p) =>
    JSON.stringify({ tool: p.toolName, input: JSON.parse(p.inputJson) as unknown }),
  )

  const adapterLayer = adapter.pipe(
    Layer.provide(floor),
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
        Layer.provideMerge(floor),
        Layer.provideMerge(hostSessionLayer),
      )
    }),
  )
}

/**
 * The §12 production composition factory. Returns a single Layer whose
 * R-channel is **`DurableStreams`** — the floor is the backend hole (Seam 1),
 * closed by a backend Live at the call site:
 *
 *     FiregridRuntime(spec, adapter).pipe(
 *       Layer.provide(DurableStreamsLive.configured),  // or .configuredWith(cfg) / a sim Live
 *     )
 *
 * The base URL is no longer a constructor input — it lives in the backend Live.
 * Override any individual Tag via `.pipe(Layer.provide(MyLive))`.
 */
export const FiregridRuntime = (
  spec: FiregridRuntimeSpec,
  adapter: FiregridRuntimeAdapterLayer,
) => composeFiregridRuntimeWithFloor(spec, adapter, runtimeProvideFloor)

export { composeFiregridRuntimeWithFloor }

/**
 * Backward-compatible wrapper for existing call sites. New code should prefer
 * `FiregridRuntime(spec, adapter)` so the adapter/floor boundary is explicit.
 *
 * Unlike `FiregridRuntime` (whose R-channel is `DurableStreams`), this shim
 * still takes `durableStreamsBaseUrl` in its options and closes the backend
 * hole itself via `DurableStreamsLive.configuredWith`, so its composed Layer
 * stays `R = never` for pre-§12 callers.
 */
export const FiregridHost = (options: FiregridHostOptions) =>
  FiregridRuntime(
    options,
    hasAdapter(options)
      ? options.adapter
      : defaultProductionAdapterLayer(options.envPolicy),
  ).pipe(
    Layer.provide(
      DurableStreamsLive.configuredWith({
        baseUrl: options.durableStreamsBaseUrl,
        namespace: options.namespace,
        ...(options.headers === undefined ? {} : { headers: options.headers }),
      }),
    ),
  )

// Re-export primitive layers for users wanting full control or
// overriding individual substrate pieces. `DurableStreams` + its Lives are
// re-exported so callers close the §12 backend hole from the same barrel they
// import `FiregridRuntime` from.
export {
  DurableStreams,
  DurableStreamsLive,
  DurableStreamsWorkflowEngine,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  StreamName,
  UnifiedTable,
}
export type { ToolExecutor }
