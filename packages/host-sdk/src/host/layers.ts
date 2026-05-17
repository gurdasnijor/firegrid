import { NodeContext } from "@effect/platform-node"
import type { WorkflowEngine } from "@effect/workflow"
import {
  CurrentHostSession,
  HostIdSegmentSchema,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  hostOwnedStreamUrl,
  makeHostSessionRow,
  runtimeControlPlaneStreamUrl,
  type HostId,
  type HostSessionId,
} from "@firegrid/protocol/launch"
import { RuntimeIngressTable } from "@firegrid/protocol/runtime-ingress"
import { Clock, Effect, Layer, Schema } from "effect"
import type { DurableTableError, DurableTableHeaders } from "effect-durable-operators"
import { RuntimeHostConfig } from "./config.ts"
import type { RuntimeHostTopologyOptions } from "./types.ts"
import { RuntimeHostAgentToolHostLive } from "./agent-tool-host-live.ts"
import {
  RuntimeContextWorkflowNativeLayer,
  RuntimeContextWorkflowSession,
} from "./runtime-context-workflow-core.ts"
import {
  HostRuntimeObservationSubstrateLive,
  RuntimeToolUseExecutorLive,
} from "./runtime-substrate.ts"
import {
  PerContextRuntimeOutputWriterLive,
} from "./per-context-runtime-output.ts"
import { DurableStreamsWorkflowEngine } from "@firegrid/runtime/workflow-engine"
import {
  LocalProcessSandboxProvider,
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

// firegrid-runtime-boundary-reconciliation.HOST_SPLIT.4
// Host layer topology is separated from command handlers; this module composes
// table, workflow, sandbox, and host-scoped capability layers.
const runtimeHostAgentToolHostWithControlPlaneLive = (
  workflowEngineLayer: Layer.Layer<
    WorkflowEngine.WorkflowEngine,
    DurableTableError,
    CurrentHostSession
  >,
) =>
  RuntimeHostAgentToolHostLive.pipe(
    Layer.provide(RuntimeControlPlaneRecorderLive),
    Layer.provide(workflowEngineLayer),
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
    LocalProcessSandboxProvider.layer(options.localProcessEnv).pipe(
      Layer.provide(NodeContext.layer),
    ),
  )

// firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.1
// firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.2
// firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.3
// firegrid-host-context-authority.EFFECT_SCOPED_CONTEXT.2
//
// Host-owned operational tables. Each layer reads CurrentHostSession
// at acquire time and routes its backing stream through the host's
// schema-encoded prefix via `hostOwnedStreamUrl`. Stream URLs are
// derived here, never composed from inline template literals at
// layer call sites.
const hostOwnedIngressLayer = (
  options: { readonly baseUrl: string; readonly headers?: DurableTableHeaders },
) =>
  Layer.unwrapEffect(
    Effect.map(CurrentHostSession, (session) =>
      RuntimeIngressTable.layer({
        streamOptions: {
          url: hostOwnedStreamUrl({
            baseUrl: options.baseUrl,
            prefix: session.streamPrefix,
            segment: "runtimeIngress",
          }),
          contentType: "application/json",
          ...(options.headers !== undefined ? { headers: options.headers } : {}),
        },
      })),
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

const hostOwnedWorkflowEngineLayer = (
  options: { readonly baseUrl: string; readonly headers?: DurableTableHeaders },
): Layer.Layer<WorkflowEngine.WorkflowEngine, DurableTableError, CurrentHostSession> =>
  Layer.unwrapEffect(
    Effect.map(CurrentHostSession, (session) =>
      DurableStreamsWorkflowEngine.layer({
        streamUrl: hostOwnedStreamUrl({
          baseUrl: options.baseUrl,
          prefix: session.streamPrefix,
          segment: "workflow",
        }),
        ...(options.headers !== undefined ? { headers: options.headers } : {}),
      })),
  )

const hostScopedLayer = (
  options: RuntimeHostTopologyOptions,
) => {
  const sharedOptions = {
    baseUrl: options.durableStreamsBaseUrl,
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
  }
  const workflowEngineLayer = hostOwnedWorkflowEngineLayer(sharedOptions)
  const hostTables = Layer.mergeAll(
    hostOwnedIngressLayer(sharedOptions),
    hostOwnedOutputLayer(sharedOptions),
    hostOwnedSandboxCommandLayer(sharedOptions),
    workflowEngineLayer,
  )
  const observation = HostRuntimeObservationSubstrateLive.pipe(
    Layer.provideMerge(hostTables),
    Layer.provideMerge(runtimeHostAgentToolHostWithControlPlaneLive(workflowEngineLayer)),
    Layer.provideMerge(PerContextRuntimeOutputWriterLive),
    // firegrid-host-sdk.TOOL_EXECUTOR_SEAM.2
    Layer.provideMerge(RuntimeToolUseExecutorLive),
  )
  const stdinClaim = SandboxStdinEmissionClaimLive.pipe(
    Layer.provideMerge(hostTables),
  )
  return Layer.mergeAll(observation, stdinClaim)
}

export const FiregridRuntimeHostLive = (
  options: RuntimeHostTopologyOptions,
  // firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6
  // Default policy denies every env binding ref. Callers that want to
  // authorize specific host env vars (e.g. firegrid:run --secret-env)
  // construct a populated policy at the binary boundary and pass it here;
  // daemons that never see --secret-env stay locked down.
  envPolicy: Layer.Layer<RuntimeEnvResolverPolicy> = RuntimeEnvResolverPolicy.denyAll,
) => {
  const session = currentHostSessionLayer(options)
  const namespaceScoped = namespaceScopedLayer(options)
  const hostScoped = hostScopedLayer(options)
  // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.8
  // Production host composition installs the native workflow/session path
  // directly; deleted legacy runner/subscriber symbols are not fallback paths.
  return RuntimeContextWorkflowNativeLayer.pipe(
    Layer.provideMerge(RuntimeContextWorkflowSessionLive),
    Layer.provideMerge(RuntimeControlPlaneRecorderLive),
    Layer.provideMerge(hostScoped),
    Layer.provideMerge(namespaceScoped),
    Layer.provideMerge(session),
    Layer.provideMerge(envPolicy),
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
  }
  return FiregridRuntimeHostWithWorkflowLive(composed, envPolicy)
}
