// Wave B canonical runtime root.
//
// `RuntimeHostLive` is the runtime-owned Layer graph that host-sdk installs
// to bring up the runtime. Per
// `docs/architecture/2026-05-22-runtime-physical-target-tree.md` (Composition
// Boundary) and `docs/architecture/2026-05-22-shape-c-cutover-roadmap.md`
// (§Wave B), this file does Layer/`Context.Tag` wiring ONLY.
//
// Hard rules
// ----------
// composition/ must not define schemas, transitions, handlers, workflow
// bodies, session behavior, or table operations; must not call producer
// append authorities, subscriber handlers, or transition functions inline;
// must not read or write durable tables; must not import any host-sdk
// module. The legacy body-driver symbols, the legacy input mailbox, the
// runtime kernel barrel, and the archive holding pen are all banned at
// lint time. See `packages/runtime/src/composition/README.md` and the
// `firegrid-composition-no-legacy-imports` Semgrep rule for the full
// symbol/path ban list.
//
// composition/ may import target folders only (`events/`, `tables/`,
// `producers/`, `transforms/`, `channels/`, `subscribers/`). Where a target
// folder still re-exports its Layer from a legacy implementation home, the
// re-export lives in that target folder's `index.ts`, NOT here. Composition
// reaches Shape D Layers through `subscribers/<name>/index.ts` shims; it
// does not import legacy substrate paths directly. The dep-cruiser
// folder-direction rules enforce the broader tier topology.
//
// What this root provides
// -----------------------
// Composed from target-shape runtime-owned Layers reached through target
// subpaths only:
//
//   - `tables/runtime-context-input-facts` → `RuntimeContextInputFactsLive`
//     (typed read source over `RuntimeControlPlaneTable.inputIntents`; the
//     greenfield replacement for the per-sequence `DurableDeferred` input
//     mailbox).
//   - `subscribers/runtime-context` → `RuntimeContextSubscriberLive`
//     (Shape C per-event handler; forks `runKeyedDispatch({source:
//     merge(inputs, outputs), handle: handleRuntimeContextEvent})` on host
//     scope at acquisition; the Wave D-A Shape (b) loop body landed in
//     PR #714 + proven by the tiny-firegrid
//     `wave-d-a-shape-b-input-identity-dedup` simulation).
//
// What this root requires (filled by host-sdk at composition time)
// ---------------------------------------------------------------
// The root Layer intentionally leaves the following as `R`-channel
// requirements rather than providing them itself:
//
//   - durable substrate tables owned by the protocol
//     (e.g. `RuntimeControlPlaneTable`) — host-sdk wires the
//     `effect-durable-operators` substrate;
//   - `RuntimeContextWorkflowSession` — host-sdk's codec/raw session adapter
//     (the runtime-owned inversion seam for the durable plane; the contract
//     lives at `subscribers/runtime-context-session/`);
//   - `RuntimeToolUseExecutor` — host-sdk wires per agent;
//   - `WorkflowEngine.WorkflowEngine` + `WorkflowEngineTable` — host-sdk
//     installs the runtime-owned `HostWorkflowEngineLive`
//     (`@firegrid/runtime/composition/host-workflow-engine`, canonical
//     composition sibling) DEEPER than any Shape D consumer
//     (`ToolDispatchLive`, etc.). The body+kernel deletion wave retired
//     the kernel's per-context engine wrapper; the canonical replacement
//     lives next to this file.
//
// `AgentSession` is intentionally NOT ambient: it is a live codec-scoped
// capability built by `AcpSessionLive` / `StdioJsonlSessionLive` from
// `AgentByteStream`. The host-sdk codec adapter stores it inside
// `CodecRuntimeContextSession` and satisfies `RuntimeContextWorkflowSession`
// against the durable plane. Leaking `AgentSession` into runtime root
// composition would re-introduce the live-codec coupling Shape C explicitly
// removes.
//
// Wave gate
// ---------
// Wave B exit gate (per
// `docs/architecture/2026-05-22-shape-c-cutover-roadmap.md` §Wave B):
//
//   - The runtime root typechecks from semantic target folders.
//   - A focused construction test proves the Layer graph can be built without
//     the old RuntimeContext body path
//     (`packages/runtime/test/composition/host-live.test.ts`).
//
// Public turn proof (Wave C) is NOT a Wave B success criterion and is not
// performed by this file. Host-sdk cutover and a real public turn through the
// new root land in a separate PR.

// ============================================================================
// Wave B partial root (retained at top): the Shape C subscriber + input facts.
// Class F3 (this slice) extends below with the full FiregridLocalHostLive /
// FiregridRuntimeHostLive / FiregridHost / RuntimeHostTopologyFromConfig
// composition. HostWorkflowEngineLive is installed INTERNALLY in the pipe so
// the outward Layer type never exposes WorkflowEngine.
// ============================================================================

import { NodeContext } from "@effect/platform-node"
import {
  CurrentHostSession,
  HostIdSegmentSchema,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  type RuntimeStartCapability,
  hostOwnedStreamUrl,
  makeHostSessionRow,
  runtimeControlPlaneStreamUrl,
  type HostId,
  type HostSessionId,
} from "@firegrid/protocol/launch"
import { Clock, Config, Effect, Layer, Option, Redacted, Schema } from "effect"
import type { DurableTableHeaders } from "effect-durable-operators"
import { RuntimeHostConfig } from "./runtime-host-config.ts"
import {
  type RuntimeHostTopologyOptions,
  RuntimeStartCapabilityLive,
} from "./host-public.ts"
import { RuntimeHostAgentToolHostLive } from "../subscribers/tool-dispatch/agent-tool-host-live.ts"
import {
  RuntimeControlRequestControlPlaneLive,
} from "../control-plane/index.ts"
import {
  RuntimeControlRequestSideEffectsLive,
} from "../subscribers/runtime-control/index.ts"
import {
  FiregridRuntimeContextMcpBaseUrlLive,
} from "../subscribers/runtime-context-session/host-mcp-base-url.ts"
import { RuntimeContextWorkflowSession } from "../subscribers/runtime-context-session/index.ts"
import {
  PerContextRuntimeAgentOutputAfterEventsLive,
  PerContextRuntimeOutputWriterLive,
  RuntimeContextStateStoreLive,
} from "./per-context-host-live.ts"
import { HostRuntimeObservationStreamsLive } from "./host-substrate.ts"
import { RuntimeToolUseExecutorLive as runtimeToolUseExecutorLayer } from "../subscribers/tool-dispatch/runtime-tool-use-executor-live.ts"
import {
  RuntimeAgentToolExecutionLive,
  ToolDispatchLive,
} from "../subscribers/tool-dispatch/index.ts"
import {
  LocalProcessSandboxProvider,
  RuntimeEnvResolverPolicy,
  SandboxStdinEmissionClaimLive,
  SandboxSupervisorCommandTable,
} from "../producers/sandbox/index.ts"
import { FiregridLocalProcess } from "../producers/sandbox/local-process-from-env.ts"
import {
  RuntimeControlPlaneRecorderLive,
} from "../control-plane/index.ts"
import type { RuntimeLocalContextResolver } from "../control-plane/index.ts"
import {
  makeCodecRuntimeContextWorkflowSessionService,
} from "../subscribers/runtime-context-session/codec-adapter.ts"
import {
  makeRawRuntimeContextWorkflowSessionService,
} from "../subscribers/runtime-context-session/raw-adapter.ts"
import { HostWorkflowEngineLive } from "./host-workflow-engine.ts"
import { RuntimeContextInputFactsLive } from "../tables/runtime-context-input-facts.ts"
import { RuntimeContextSubscriberLive } from "../subscribers/runtime-context/index.ts"
import {
  type RuntimeChannelRouter,
} from "../channels/router/live.ts"
import {
  SessionSelfChannelsLive,
} from "../channels/session-self/live.ts"
import {
  HostControlChannelsLive,
} from "../channels/host-control/live.ts"
import type { SessionAgentOutputChannel } from "@firegrid/protocol/channels"
import {
  SessionAgentOutputChannelLive,
} from "../channels/session-agent-output/live.ts"

/**
 * Canonical runtime root Layer for the Shape C target tree.
 *
 * Wave B partial: provided services come from `tables/` and the Shape C
 * subscriber. Outer host composition (`FiregridRuntimeHostLive` below)
 * provideMerges this against the host substrate.
 */
export const RuntimeHostLive = RuntimeContextSubscriberLive.pipe(
  Layer.provideMerge(RuntimeContextInputFactsLive),
)

// ============================================================================
// Class F3 — full host composition relocated from deleted
// `host-sdk/src/host/layers.ts`. Outward Layer type does NOT expose
// `WorkflowEngine` (HostWorkflowEngineLive folded internally).
// ============================================================================

const runtimeEnvResolverPolicyLayer = (
  envPolicy?: Layer.Layer<RuntimeEnvResolverPolicy>,
): Layer.Layer<RuntimeEnvResolverPolicy> =>
  envPolicy ??
  Layer.unwrapEffect(
    Effect.map(
      Effect.serviceOption(RuntimeEnvResolverPolicy),
      Option.match({
        onNone: () => RuntimeEnvResolverPolicy.denyAll,
        onSome: policy => Layer.succeed(RuntimeEnvResolverPolicy, policy),
      }),
    ),
  )

const localProcessSandboxProviderLayer = (
  options: RuntimeHostTopologyOptions,
) =>
  options.localProcessEnv === undefined
    ? Layer.unwrapEffect(
      Effect.map(
        Effect.serviceOption(FiregridLocalProcess),
        Option.match({
          onNone: () => LocalProcessSandboxProvider.layer(undefined),
          onSome: localProcessEnv => LocalProcessSandboxProvider.layer(localProcessEnv),
        }),
      ),
    ).pipe(Layer.provide(NodeContext.layer))
    : LocalProcessSandboxProvider.layer(options.localProcessEnv).pipe(
      Layer.provide(NodeContext.layer),
    )

// Wave D-A (PR #714): host-scope bundle that satisfies
// `RuntimeContextSubscriberLive`'s R channel — the Shape C loop body's
// per-context state store + tool executor live alongside `RuntimeHostLive`.
//
// `RuntimeToolUseExecutorLive` (`runtimeToolUseExecutorLayer`) captures
// `RuntimeAgentToolExecution` at Layer-build time via `Effect.context<…>()`;
// the canonical Live for that Tag (`RuntimeAgentToolExecutionLive`) must
// therefore be UNDER the executor in the same bundle so the capture
// succeeds. Without it, `Layer.build(FiregridRuntimeHostLive)` fails with
// `Service not found: @firegrid/runtime/RuntimeAgentToolExecution` and no
// `firegrid run` invocation can start. The old host-sdk composition had
// the same gap; this restoration lands at the canonical runtime home
// (Class F3 follow-up).
const runtimeContextSubscriberHostBundle = RuntimeHostLive.pipe(
  Layer.provideMerge(RuntimeContextStateStoreLive),
  Layer.provideMerge(runtimeToolUseExecutorLayer),
  Layer.provideMerge(RuntimeAgentToolExecutionLive),
  // `RuntimeToolUseExecutorLive` also captures `RuntimeObservationStreams`
  // at Layer-build time. The canonical Live (`RuntimeObservationStreamsLive`)
  // requires `RuntimeAgentOutputEvents` + the per-context after-events seam,
  // which `HostRuntimeObservationStreamsLive` composes from the host
  // observation substrate. Same provideMerge ordering rationale as above.
  Layer.provideMerge(HostRuntimeObservationStreamsLive),
)

const RuntimeContextWorkflowSessionLive = Layer.scoped(
  RuntimeContextWorkflowSession,
  Effect.gen(function*() {
    const raw = yield* makeRawRuntimeContextWorkflowSessionService
    const codec = yield* makeCodecRuntimeContextWorkflowSessionService
    const pick = (context: Parameters<typeof raw.startOrAttach>[0]) =>
      context.runtime.config.agentProtocol === undefined || context.runtime.config.agentProtocol === "raw"
        ? raw
        : codec
    return RuntimeContextWorkflowSession.of({
      startOrAttach: (context, activityAttempt) =>
        pick(context).startOrAttach(context, activityAttempt),
      send: (context, activityAttempt, command) =>
        pick(context).send(context, activityAttempt, command),
      deregister: (contextId) =>
        Effect.zipRight(raw.deregister(contextId), codec.deregister(contextId)),
    })
  }),
)

const hostOwnedSandboxCommandLayer = (
  options: { readonly baseUrl: string; readonly headers?: DurableTableHeaders },
) =>
  Layer.unwrapEffect(
    Effect.map(CurrentHostSession, (session) =>
      SandboxSupervisorCommandTable.layer({
        streamOptions: {
          url: hostOwnedStreamUrl({
            baseUrl: options.baseUrl,
            prefix: session.streamPrefix,
            segment: "durableTools",
          }),
          contentType: "application/json",
          ...(options.headers !== undefined ? { headers: options.headers } : {}),
        },
      })),
  )

const currentHostSessionLayer = (
  options: RuntimeHostTopologyOptions,
) =>
  Layer.effect(
    CurrentHostSession,
    Effect.gen(function* () {
      const startedAtMs = yield* Clock.currentTimeMillis
      const hostId = options.hostId as HostId
      const hostSessionId = (options.hostSessionId
        ?? `session-${crypto.randomUUID()}`) as HostSessionId
      return makeHostSessionRow({
        hostId,
        hostSessionId,
        namespace: options.namespace,
        startedAtMs,
      })
    }),
  )

const namespaceScopedLayer = (
  options: RuntimeHostTopologyOptions,
) =>
  Layer.mergeAll(
    Layer.succeed(RuntimeHostConfig, {
      inputEnabled: options.input === true,
      durableStreamsBaseUrl: options.durableStreamsBaseUrl,
      namespace: options.namespace,
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
    }),
    RuntimeControlPlaneTable.layer({
      streamOptions: {
        url: runtimeControlPlaneStreamUrl({
          baseUrl: options.durableStreamsBaseUrl,
          namespace: options.namespace,
        }),
        contentType: "application/json",
        ...(options.headers !== undefined ? { headers: options.headers } : {}),
      },
    }),
    localProcessSandboxProviderLayer(options),
  )

const hostOwnedOutputLayer = (
  options: { readonly baseUrl: string; readonly headers?: DurableTableHeaders },
) =>
  Layer.unwrapEffect(
    Effect.map(CurrentHostSession, (session) =>
      RuntimeOutputTable.layer({
        streamOptions: {
          url: hostOwnedStreamUrl({
            baseUrl: options.baseUrl,
            prefix: session.streamPrefix,
            segment: "runtimeOutput",
          }),
          contentType: "application/json",
          ...(options.headers !== undefined ? { headers: options.headers } : {}),
        },
      })),
  )

const hostScopedLayer = (
  options: RuntimeHostTopologyOptions,
) => {
  const sharedOptions = {
    baseUrl: options.durableStreamsBaseUrl,
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
  }
  const hostTables = Layer.mergeAll(
    hostOwnedOutputLayer(sharedOptions),
    hostOwnedSandboxCommandLayer(sharedOptions),
  )
  const hostServices = RuntimeHostAgentToolHostLive.pipe(
    Layer.provide(RuntimeControlPlaneRecorderLive),
    Layer.provideMerge(PerContextRuntimeAgentOutputAfterEventsLive),
    Layer.provideMerge(PerContextRuntimeOutputWriterLive),
    Layer.provideMerge(SessionAgentOutputChannelLive),
    Layer.provideMerge(hostTables),
  )
  const stdinClaim = SandboxStdinEmissionClaimLive.pipe(
    Layer.provideMerge(hostTables),
  )
  return Layer.mergeAll(hostServices, stdinClaim)
}

/** @category models */
export type FiregridHost =
  | RuntimeStartCapability
  | SessionAgentOutputChannel
  | CurrentHostSession
  | RuntimeLocalContextResolver
  | RuntimeControlPlaneTable
  | RuntimeOutputTable
  | RuntimeChannelRouter

export const FiregridRuntimeHostLive = (
  options: RuntimeHostTopologyOptions,
  envPolicy?: Layer.Layer<RuntimeEnvResolverPolicy>,
) => {
  const session = currentHostSessionLayer(options)
  const namespaceScoped = namespaceScopedLayer(options)
  const hostScoped = hostScopedLayer(options)
  const hostChannels = SessionSelfChannelsLive(options.mcpChannels)
  const hostPublic = RuntimeStartCapabilityLive.pipe(
    Layer.provideMerge(hostChannels),
    Layer.provideMerge(HostControlChannelsLive),
  )
  const controlPlane = RuntimeControlRequestControlPlaneLive({
    durableStreamsBaseUrl: options.durableStreamsBaseUrl,
    namespace: options.namespace,
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
    daemon: options.controlRequestReconciler !== false,
  }).pipe(
    Layer.provideMerge(RuntimeControlRequestSideEffectsLive),
  )
  return controlPlane.pipe(
    Layer.provideMerge(runtimeContextSubscriberHostBundle),
    Layer.provideMerge(ToolDispatchLive),
    Layer.provideMerge(hostPublic),
    Layer.provideMerge(RuntimeContextWorkflowSessionLive),
    Layer.provideMerge(RuntimeControlPlaneRecorderLive),
    Layer.provideMerge(hostScoped),
    // HostWorkflowEngineLive is installed INSIDE the pipe so the outward
    // Layer type never exposes WorkflowEngine to callers.
    Layer.provideMerge(HostWorkflowEngineLive),
    Layer.provideMerge(namespaceScoped),
    Layer.provideMerge(session),
    Layer.provideMerge(runtimeEnvResolverPolicyLayer(envPolicy)),
    Layer.provideMerge(FiregridRuntimeContextMcpBaseUrlLive),
    Layer.annotateSpans("firegrid.side", "host"),
  )
}

export const FiregridRuntimeHostWithWorkflowLive = (
  options: RuntimeHostTopologyOptions,
  envPolicy?: Layer.Layer<RuntimeEnvResolverPolicy>,
) => FiregridRuntimeHostLive(options, envPolicy)

const localHostIdForNamespace = (namespace: string): HostId => {
  const sanitized = namespace.replaceAll(".", "_")
  return Schema.decodeUnknownSync(HostIdSegmentSchema)(`${sanitized}-host`)
}

// firegrid-runtime-boundary-reconciliation.HOST_SPLIT.4
// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.3
//
// `RuntimeHostTopologyFromConfig` is the env-derived `RuntimeHostTopologyOptions`
// shape that `firegrid:host` consumes. Host identity is NOT an env knob:
// `FiregridLocalHostLive` derives the host id deterministically from the
// namespace. Multi-host topologies bypass this Config entirely and supply
// `hostId` at the programmatic composition boundary via
// `FiregridRuntimeHostLive`.
export const RuntimeHostTopologyFromConfig = Config.all({
  durableStreamsBaseUrl: Config.string("DURABLE_STREAMS_BASE_URL"),
  namespace: Config.string("FIREGRID_RUNTIME_NAMESPACE"),
  input: Config.boolean("FIREGRID_RUNTIME_INPUT_ENABLED").pipe(
    Config.withDefault(false),
  ),
  token: Config.option(Config.redacted("FIREGRID_DURABLE_STREAMS_TOKEN")),
}).pipe(
  Config.map(({ durableStreamsBaseUrl, namespace, input, token }) => {
    const headers = Option.match(token, {
      onNone: () => undefined,
      onSome: (redacted) => ({
        Authorization: () => `Bearer ${Redacted.value(redacted)}`,
      }) satisfies DurableTableHeaders,
    })
    return {
      durableStreamsBaseUrl,
      namespace,
      input,
      ...(headers !== undefined ? { headers } : {}),
    }
  }),
)

export const FiregridLocalHostLive = (
  options: {
    readonly durableStreamsBaseUrl: string
    readonly namespace: string
    readonly input?: boolean
    readonly headers?: DurableTableHeaders
    readonly localProcessEnv?: RuntimeHostTopologyOptions["localProcessEnv"]
    readonly controlRequestReconciler?: boolean
    readonly mcpChannels?: RuntimeHostTopologyOptions["mcpChannels"]
  },
  envPolicy?: Layer.Layer<RuntimeEnvResolverPolicy>,
) => {
  const composed: RuntimeHostTopologyOptions = {
    durableStreamsBaseUrl: options.durableStreamsBaseUrl,
    namespace: options.namespace,
    hostId: localHostIdForNamespace(options.namespace),
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.localProcessEnv === undefined
      ? {}
      : { localProcessEnv: options.localProcessEnv }),
    ...(options.controlRequestReconciler === undefined
      ? {}
      : { controlRequestReconciler: options.controlRequestReconciler }),
    ...(options.mcpChannels === undefined
      ? {}
      : { mcpChannels: options.mcpChannels }),
  }
  return FiregridRuntimeHostWithWorkflowLive(composed, envPolicy)
}
