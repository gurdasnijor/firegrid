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
 *     `UnifiedChannelBindingsLive` (overridable)
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
 * `RuntimeContextSessionAdapter` Live; `makeRecorderAdapter` is the
 * canonical test stand-in.
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
} from "../sources/sandbox/index.ts"
import { type RuntimeContextSessionAdapter } from "./adapter.ts"
import {
  ProductionCodecAdapterLive,
} from "./codec-adapter.ts"
import {
  CodecOutputJournalFromRuntimeOutputTableLive,
  ContextResolverFromControlPlaneTableLive,
} from "../tables/codec-adapter-providers.ts"
import { buildCurrentHostSessionLayer } from "./host-identity.ts"
import { SignalTable } from "./signal.ts"
import { UnifiedTable } from "./tables.ts"
import {
  UnifiedChannelBindingsLive,
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
  buildWebhookFactObserverLayer,
} from "./subscribers/scheduled-webhook-peer.ts"
import { JournalObserverLive } from "./observers.ts"
import { HostControlChannelBindingsLive } from "../channels/host-control.ts"

export interface FiregridHostOptionsBase {
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

export interface FiregridHostOptionsWithAdapter extends FiregridHostOptionsBase {
  /**
   * Compose the session adapter Layer yourself. Required for sims or
   * non-ACP hosts; use the `codec: "acp"` sugar option below for the
   * default production path.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly adapter: Layer.Layer<RuntimeContextSessionAdapter, never, any>
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

const hasAdapter = (
  options: FiregridHostOptions,
): options is FiregridHostOptionsWithAdapter => "adapter" in options

const defaultProductionAdapterLayer = (
  envPolicy: Layer.Layer<RuntimeEnvResolverPolicy> = RuntimeEnvResolverPolicy.denyAll,
) =>
  ProductionCodecAdapterLive.pipe(
    Layer.provide(
      LocalProcessSandboxProvider.layer().pipe(
        Layer.provide(NodeContext.layer),
      ),
    ),
    Layer.provide(
      Layer.succeed(IdGenerator.IdGenerator, IdGenerator.defaultIdGenerator),
    ),
    Layer.provide(ContextResolverFromControlPlaneTableLive),
    Layer.provide(CodecOutputJournalFromRuntimeOutputTableLive),
    Layer.provide(envPolicy),
  )

const jsonStreamOptions = (
  url: string,
  headers: DurableTableHeaders | undefined,
) => ({
  url,
  contentType: "application/json",
  ...(headers === undefined ? {} : { headers }),
})

const tableLayer = (options: FiregridHostOptions) =>
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
    SignalTable.layer({
      streamOptions: {
        url: durableStreamUrl(
          options.durableStreamsBaseUrl,
          `${options.namespace}.firegrid.signals`,
        ),
        contentType: "application/json",
        ...(options.headers === undefined ? {} : { headers: options.headers }),
      },
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

const engineLayer = (options: FiregridHostOptions) =>
  DurableStreamsWorkflowEngine.layer({
    streamUrl: durableStreamUrl(
      options.durableStreamsBaseUrl,
      `${options.namespace}.firegrid.engine`,
    ),
  })

/**
 * The production composition factory. Returns a single Layer that
 * satisfies the substrate + channel + workflow Tags a Firegrid host
 * needs. The R-channel is `never` — composition is self-contained.
 *
 * Override any individual Tag via `.pipe(Layer.provide(MyLive))`.
 */
export const FiregridHost = (options: FiregridHostOptions) => {
  const toolExecutorEffect = makeToolExecutor((p) =>
    JSON.stringify({ tool: p.toolName, input: JSON.parse(p.inputJson) as unknown }),
  )

  const adapterLayer = hasAdapter(options)
    ? options.adapter
    : defaultProductionAdapterLayer(options.envPolicy)
  const hostSessionLayer = buildCurrentHostSessionLayer({
    namespace: options.namespace,
    ...(options.hostId === undefined ? {} : { hostId: options.hostId }),
  })

  return Layer.unwrapEffect(
    Effect.gen(function*() {
      const toolExecutor = yield* toolExecutorEffect
      const workflowLayers = Layer.mergeAll(
        RuntimeContextSessionWorkflowLayer.pipe(Layer.provide(adapterLayer)),
        buildPermissionRoundtripLayer(),
        buildToolDispatchLayer(toolExecutor),
        buildScheduledPromptLayer(),
        buildWebhookFactObserverLayer(),
        buildPeerEventObserverLayer(),
      )
      // Two-layer channel composition: stub Lives satisfy every Tag at
      // build time; the signaling Lives REPLACE the four input-delivery
      // stubs with real signal-sending implementations. Tag-identity
      // merge dedup — last Live wins per Tag.
      const channelsAndObserver = UnifiedChannelBindingsLive.pipe(
        Layer.provideMerge(HostControlChannelBindingsLive({
          durableStreamsBaseUrl: options.durableStreamsBaseUrl,
          ...(options.headers === undefined ? {} : { headers: options.headers }),
        })),
        Layer.provideMerge(UnifiedSignalingChannelBindingsLive),
        Layer.provideMerge(JournalObserverLive),
      )
      return Layer.mergeAll(
        workflowLayers,
        channelsAndObserver,
      ).pipe(
        Layer.provideMerge(engineLayer(options)),
        Layer.provideMerge(hostSessionLayer),
        Layer.provideMerge(tableLayer(options)),
      )
    }),
  )
}

// Re-export primitive layers for users wanting full control or
// overriding individual substrate pieces.
export {
  DurableStreamsWorkflowEngine,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  SignalTable,
  UnifiedTable,
}
export type { ToolExecutor }
