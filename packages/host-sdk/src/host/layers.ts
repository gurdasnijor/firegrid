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
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import type { DurableTableHeaders } from "effect-durable-operators"
import { RuntimeHostConfig } from "./config.ts"
import type { RuntimeHostTopologyOptions } from "./types.ts"
import { RuntimeHostAgentToolHostLive } from "./agent-tool-host-live.ts"
import { RuntimeStartCapabilityLive } from "./commands.ts"
import {
  RuntimeControlRequestReconcilerDaemonLive,
  RuntimeControlRequestReconcilerLive,
  RuntimeControlRequestWorkflowEngineLive,
} from "./control-request-reconciler.ts"
import {
  FiregridRuntimeContextMcpBaseUrlLive,
} from "./runtime-context-mcp-base-url.ts"
import {
  RuntimeContextWorkflowSession,
} from "./runtime-context-workflow-core.ts"
import {
  PerContextRuntimeOutputWriterLive,
} from "./per-context-runtime-output.ts"
import {
  LocalProcessSandboxProvider,
  localProcessSpawnEnvFromHostEnv,
  type LocalProcessSandboxProviderOptions,
  RuntimeEnvResolverPolicy,
  SandboxStdinEmissionClaimLive,
  SandboxSupervisorCommandTable,
} from "@firegrid/runtime/sources/sandbox"
import {
  RuntimeControlPlaneRecorderLive,
} from "@firegrid/runtime/control-plane"
import {
  makeCodecRuntimeContextWorkflowSessionService,
} from "./runtime-context-session/codec-adapter.ts"
import {
  makeRawRuntimeContextWorkflowSessionService,
} from "./runtime-context-session/raw-adapter.ts"
import {
  RuntimeContextEngineRegistryLive,
  RuntimeInputIntentDispatcherLive,
} from "./runtime-context-engine-registry.ts"

export class FiregridLocalProcess extends Context.Tag(
  "firegrid/host-sdk/FiregridLocalProcess",
)<FiregridLocalProcess, LocalProcessSandboxProviderOptions>() {}

export const FiregridLocalProcessFromEnv = (
  processEnv: Record<string, string | undefined>,
): Layer.Layer<FiregridLocalProcess> =>
  Layer.succeed(FiregridLocalProcess, localProcessSpawnEnvFromHostEnv(processEnv))

export const FiregridEnvBindingsFromEnv = (
  options: {
    readonly processEnv: Record<string, string | undefined>
    readonly allow: Iterable<readonly [bindingName: string, envName: string]>
  },
): Layer.Layer<RuntimeEnvResolverPolicy> =>
  RuntimeEnvResolverPolicy.withPolicy({
    authorizedBindings: options.allow,
    lookupEnv: name => options.processEnv[name],
  })

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

// firegrid-host-context-authority.EFFECT_SCOPED_CONTEXT.1
// firegrid-host-context-authority.EFFECT_SCOPED_CONTEXT.2
//
// CurrentHostSession layer for the host scope. The session row carries
// the schema-encoded stream prefix that host-owned ingress / output /
// workflow layers read; long-lived layers see exactly one host
// identity for their lifetime.
// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.3
//
// Host identity is required at the topology type, so this layer is
// never asked to fabricate one. No env, disk, or random fallback —
// the only sanctioned suppliers are direct callers passing
// `options.hostId` and the `FiregridLocalHostLive` helper that
// derives a deterministic per-namespace id.
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

// Namespace-scoped infrastructure: control plane, host config, sandbox
// provider. The RuntimeContext index stays at `{namespace}.firegrid.runtime`
// so cross-host context lookup does not require a host directory.
const namespaceScopedLayer = (
  options: RuntimeHostTopologyOptions,
) =>
  Layer.mergeAll(
    Layer.succeed(RuntimeHostConfig, {
      // firegrid-agent-ingress.HOST.7
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

// firegrid-typed-wait-source-redesign.WAIT_ROUTER.1
//
// CYCLE 1 CLEANUP CANDIDATE — host-prefixed ambient `RuntimeOutputTable`
// with NO production writer post-#315.
//
// This binds the ambient `RuntimeOutputTable` to the host-prefixed
// stream `…firegrid.host.{hostId}.runtimeOutput`. Runtime output is
// written per-context by `PerContextRuntimeOutputWriter`
// (`{prefix}.runtimeOutput.context.{contextId}`), so nothing writes
// this stream. It exists only to satisfy a *structural* dependency:
// `RuntimeObservationStreamsLive` resolves `RuntimeAgentOutputEvents`
// (`RuntimeAgentOutputEventsLayer` → ambient `RuntimeOutputTable`) as a
// hard requirement, and the wait router's now-dead host-wide
// `agentOutput` fallback reads it. The live `AgentOutput` path is
// per-context (see `wait-router.ts` / `runtime-wait-streams.ts`).
// Removing this layer is gated on reshaping that structural dependency.
// See docs/research/host-vs-context-boundary-audit.md §A4.
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
  const hostServices = Layer.mergeAll(
    PerContextRuntimeOutputWriterLive,
    RuntimeHostAgentToolHostLive.pipe(
      Layer.provide(RuntimeControlPlaneRecorderLive),
    ),
  ).pipe(
    Layer.provideMerge(hostTables),
  )
  const stdinClaim = SandboxStdinEmissionClaimLive.pipe(
    Layer.provideMerge(hostTables),
  )
  return Layer.mergeAll(hostServices, stdinClaim)
}

// firegrid-host-surface (docs/sdds/SDD_FIREGRID_HOST_SURFACE.md)
//
// The named Firegrid host surface: the public, protocol-owned services a
// composed Firegrid host provides to its consumers. Modeled on Effect's
// own `NodeContext` / `BunContext` precedent — a `@category models` union,
// NOT a service Tag.
//
// Consumers annotate their own host handle with this type
// (`const host: Layer.Layer<FiregridHost, ...> = FiregridRuntimeHostLive(...)`),
// which is sound because `Layer` `ROut` is contravariant: the host layer
// provides `FiregridHost` plus host-sdk-internal tags, and narrowing the
// declared output to the public subset only forgets the internals.
//
// The factory return types are intentionally NOT annotated to
// `Layer.Layer<FiregridHost, ...>` yet: doing so is entangled with the
// open Finding 3 `any` ROut leak in this composition, which the host-sdk
// test suite currently depends on to discharge internal requirements.
// See SDD_FIREGRID_HOST_SURFACE.md "Risk and validation".
/** @category models */
export type FiregridHost =
  | RuntimeStartCapability
  | CurrentHostSession
  | RuntimeControlPlaneTable
  | RuntimeOutputTable

export const FiregridRuntimeHostLive = (
  options: RuntimeHostTopologyOptions,
  // firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6
  // Default policy denies every env binding ref. Callers that want to
  // authorize specific host env vars (e.g. firegrid:run --secret-env)
  // construct a populated policy at the binary boundary and pass it here;
  // daemons that never see --secret-env stay locked down.
  envPolicy?: Layer.Layer<RuntimeEnvResolverPolicy>,
) => {
  const session = currentHostSessionLayer(options)
  const namespaceScoped = namespaceScopedLayer(options)
  const hostScoped = hostScopedLayer(options)
  // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.8
  // Production host composition installs the native workflow/session path
  // directly; deleted legacy runner/subscriber symbols are not fallback paths.
  return Layer.mergeAll(
    RuntimeInputIntentDispatcherLive,
    RuntimeStartCapabilityLive,
    RuntimeControlRequestReconcilerLive,
    RuntimeControlRequestWorkflowEngineLive,
    ...(options.controlRequestReconciler === false
      ? []
      : [RuntimeControlRequestReconcilerDaemonLive]),
  ).pipe(
    Layer.provideMerge(RuntimeContextWorkflowSessionLive),
    Layer.provideMerge(RuntimeControlPlaneRecorderLive),
    Layer.provideMerge(hostScoped),
    Layer.provideMerge(RuntimeContextEngineRegistryLive),
    Layer.provideMerge(namespaceScoped),
    Layer.provideMerge(session),
    Layer.provideMerge(runtimeEnvResolverPolicyLayer(envPolicy)),
    // TFIND-048: single-owner, host-scoped late-bind channel for the
    // runtime-context MCP base URL. Present (defaulting to `None`) even
    // when the MCP listener is disabled, so the codec start path can
    // resolve it and an MCP-marked context on an MCP-less host fails
    // explicitly. When `FiregridMcpServerLayer` (A) is
    // `Layer.provideMerge`'d with this host (B), A publishes its bound
    // address into this same instance.
    Layer.provideMerge(FiregridRuntimeContextMcpBaseUrlLive),
    Layer.annotateSpans("firegrid.side", "host"),
  )
}

export const FiregridRuntimeHostWithWorkflowLive = (
  options: RuntimeHostTopologyOptions,
  envPolicy?: Layer.Layer<RuntimeEnvResolverPolicy>,
) => FiregridRuntimeHostLive(options, envPolicy)

// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.3
// firegrid-host-context-authority.EFFECT_SCOPED_CONTEXT.1
//
// Single production composition for a one-host-per-namespace local
// runtime. The helper owns `CurrentHostSession` internally; callers
// supply only the namespace + base URL + optional headers/input and
// then talk to `Firegrid` / `startRuntime` through the normal public
// surface. Host identity is derived deterministically from the
// namespace, so every process composing this layer with the same
// namespace converges on the same `hostId` — no env knob, no
// filesystem state, no random fallback.
//
// Multi-host topologies (e.g. the two-host workflow stream isolation
// unit test) bypass this helper and pass `hostId` to
// `FiregridRuntimeHostWithWorkflowLive` at the programmatic test
// composition boundary.
//
// `HostStreamPrefixPartsSchema` requires the hostId to be a single
// dot-free segment; namespaces are allowed to contain dots, so the
// derivation replaces `.` with `_` to keep the result schema-valid.
// The derived id is decoded through `HostIdSegmentSchema` — which
// shares its dot-free / non-empty invariants with the prefix
// validator — so a future constraint change here fails loudly at
// composition time rather than at table construction.
const localHostIdForNamespace = (namespace: string): HostId => {
  const sanitized = namespace.replaceAll(".", "_")
  return Schema.decodeUnknownSync(HostIdSegmentSchema)(`${sanitized}-host`)
}

export const FiregridLocalHostLive = (
  options: {
    readonly durableStreamsBaseUrl: string
    readonly namespace: string
    readonly input?: boolean
    readonly headers?: DurableTableHeaders
    readonly localProcessEnv?: RuntimeHostTopologyOptions["localProcessEnv"]
    readonly controlRequestReconciler?: boolean
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
  }
  return FiregridRuntimeHostWithWorkflowLive(composed, envPolicy)
}
