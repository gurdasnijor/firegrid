import { Prompt } from "@effect/ai"
import { NodeContext } from "@effect/platform-node"
import {
  Activity,
  Workflow,
  WorkflowEngine,
} from "@effect/workflow"
import {
  HostIdSegmentSchema,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  RuntimeStartCapability,
  type RuntimeAgentProtocol,
  local,
  makeHostSessionRow,
  normalizeRuntimeIntent,
  type HostId,
  type HostSessionRow,
  type HostSessionId,
  type RuntimeContext,
  type RuntimeEventRow,
  type RuntimeLogLineRow,
} from "@firegrid/protocol/launch"
import {
  RuntimeIngressTable,
  type RuntimeIngressRequest,
} from "@firegrid/protocol/runtime-ingress"
import { Clock, Config, Effect, Layer, Option, Redacted, Schema, Stream } from "effect"
import type { DurableTableHeaders } from "effect-durable-operators"
import {
  ContextNotLocal,
  CurrentHostSession,
  hostOwnedStreamUrl,
  provideRuntimeContext,
  requireLocalContext,
  runtimeControlPlaneStreamUrl,
} from "./authority-context.ts"
import { executeRuntimeContextWorkflow } from "./internal/run-context-workflow.ts"
import {
  LocalProcessSandboxProvider,
  RuntimeEnvResolverPolicy,
  commandForContext,
  localProcessStdinDelivery,
  streamSandboxProcess,
  type ProcessOutputChunk,
  type SandboxProviderError,
} from "../sources/sandbox/index.ts"
import {
  RuntimeIngressError,
  RuntimeContextError,
  asRuntimeContextError,
  mapRuntimeContextError,
  runtimeIngressError,
} from "./errors.ts"
import { RuntimeHostConfig } from "./config.ts"
import { DurableStreamsWorkflowEngine } from "../workflow-engine/DurableStreamsWorkflowEngine.ts"
import type {
  RuntimeHostTopologyOptions,
  StartRuntimeOptions,
} from "./types.ts"
import {
  AgentToolHost,
  type AgentToolHostService,
} from "../agent-tools/tool-host.ts"
import { ScheduledInputWorkflowLayer } from "../agent-tools/scheduled-input-workflow.ts"
import { toolExecutionFailed } from "../agent-tools/tool-error.ts"
import { DurableToolsWaitForLive } from "../waits/DurableToolsWaitFor.ts"
import { RuntimeObservationSourcesLive } from "./observation-sources.ts"
import {
  RuntimeContextInsert,
  type RuntimeContextInsertService,
  RuntimeContextRead,
  type RuntimeContextReadService,
  RuntimeControlPlaneRecorderLive,
  RuntimeEventAppendAndGet,
  RuntimeIngressAppendAndGet,
  RuntimeIngressAppenderLayer,
  RuntimeIngressInputStreamLayer,
  RuntimeIngressDeliveryTrackerLayer,
  RuntimeLogLineAppendAndGet,
  RuntimeOutputJournalLayer,
  RuntimeRunAppendAndGet,
  runtimeIngressSubscriberId,
} from "../authorities/index.ts"
import { runCodecRuntimeEventPipeline } from "../pipeline/index.ts"

export type {
  RuntimeHostTopologyOptions,
  StartRuntimeOptions,
  StartRuntimeResult,
} from "./types.ts"

export {
  ContextNotFound,
  ContextNotLocal,
  CurrentHostSession,
  CurrentHostStopped,
  CurrentRuntimeContext,
  durableStreamUrl,
  findRuntimeContext,
  hostOwnedStreamUrl,
  provideRuntimeContext,
  requireLocalContext,
  runtimeControlPlaneStreamUrl,
} from "./authority-context.ts"

export {
  RuntimeObservationSourceNames,
  type RuntimeAgentOutputObservation,
  type RuntimeObservationSourceName,
} from "./observation-sources.ts"

export {
  RuntimeIngressError,
}
export {
  localProcessSpawnEnvFromHostEnv,
  type LocalProcessSandboxProviderOptions,
} from "../sources/sandbox/local-process.ts"

type SequencedChunk = {
  readonly sequence: number
  readonly chunk: ProcessOutputChunk
}

type RuntimeOutputRow = RuntimeEventRow | RuntimeLogLineRow

const RuntimeContextWorkflowPayload = Schema.Struct({
  contextId: Schema.String,
})

const RuntimeExitEvidence = Schema.Struct({
  exitCode: Schema.Number,
  signal: Schema.optional(Schema.String),
})

const StartRuntimeResultSchema = Schema.Struct({
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  exitCode: Schema.Number,
  signal: Schema.optional(Schema.String),
})

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map(millis => new Date(millis).toISOString()),
)

const localProcessStdinSubscriberId = runtimeIngressSubscriberId("raw", "stdin")

const runtimeContextWorkflowExecutionId = (contextId: string) =>
  `runtime-context:${contextId}`

const runtimeExecutionClock = Clock.make()

const outputRowFromProcessChunk = (
  context: RuntimeContext,
  activityAttempt: number,
  sequence: number,
  chunk: Extract<ProcessOutputChunk, { readonly type: "output" }>,
): Effect.Effect<RuntimeOutputRow, RuntimeContextError> =>
  Effect.gen(function* () {
    const rule = context.runtime.journal.find(candidate => candidate.source === chunk.channel)
    if (rule === undefined) {
      return yield* Effect.fail(asRuntimeContextError(
        "runtime-output.no-journal-rule",
        `no runtime journal rule for ${chunk.channel}`,
        context.contextId,
      ))
    }

    const receivedAt = yield* nowIso
    if (rule.target === "events" && rule.format === "jsonl" && chunk.channel === "stdout") {
      return {
        eventId: {
          contextId: context.contextId,
          activityAttempt,
          target: "events",
          sequence,
        },
        contextId: context.contextId,
        activityAttempt,
        sequence,
        source: "stdout",
        format: "jsonl",
        receivedAt,
        raw: chunk.text,
      }
    }

    if (rule.target === "logs" && rule.format === "text-lines" && chunk.channel === "stderr") {
      return {
        logLineId: {
          contextId: context.contextId,
          activityAttempt,
          target: "logs",
          sequence,
        },
        contextId: context.contextId,
        activityAttempt,
        sequence,
        source: "stderr",
        format: "text-lines",
        receivedAt,
        raw: chunk.text,
      }
    }

    return yield* Effect.fail(asRuntimeContextError(
      "runtime-output.invalid-journal-rule",
      `unsupported runtime journal rule ${rule.source}:${rule.format}->${rule.target}`,
      context.contextId,
    ))
  })

const agentProtocolForContext = (
  context: RuntimeContext,
): RuntimeAgentProtocol => context.runtime.config.agentProtocol ?? "raw"

const HostOwnedDurableToolsWaitForLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const session = yield* CurrentHostSession
    const config = yield* RuntimeHostConfig
    return DurableToolsWaitForLive({
      streamUrl: hostOwnedStreamUrl({
        baseUrl: config.durableStreamsBaseUrl,
        prefix: session.streamPrefix,
        segment: "durableTools",
      }),
      ...(config.headers === undefined ? {} : { headers: config.headers }),
    })
  }),
)

const runtimeCodecToolLoweringLayer = () =>
  RuntimeObservationSourcesLive.pipe(
    Layer.provideMerge(HostOwnedDurableToolsWaitForLive),
    Layer.provideMerge(RuntimeOutputJournalLayer),
    Layer.provideMerge(RuntimeControlPlaneRecorderLive),
    Layer.provideMerge(RuntimeIngressInputStreamLayer),
    Layer.provideMerge(RuntimeIngressDeliveryTrackerLayer),
    Layer.provideMerge(ScheduledInputWorkflowLayer),
    Layer.provideMerge(RuntimeHostAgentToolHostLive),
  )

const runCodecRuntimeContext = (options: {
  readonly context: RuntimeContext
  readonly activityAttempt: number
  readonly protocol: Exclude<RuntimeAgentProtocol, "raw">
}) => runCodecRuntimeEventPipeline({
  context: options.context,
  activityAttempt: options.activityAttempt,
  protocol: options.protocol,
  toolLoweringLayer: runtimeCodecToolLoweringLayer(),
}).pipe(
  Effect.provide(RuntimeOutputJournalLayer),
  Effect.provide(RuntimeIngressAppenderLayer({
    currentContextId: options.context.contextId,
  })),
  Effect.provide(RuntimeIngressDeliveryTrackerLayer),
)

const readRuntimeContext = (
  contextId: string,
) =>
  Effect.gen(function* () {
    const contextRead = yield* RuntimeContextRead
    const maybeContext = yield* contextRead.readContext(contextId).pipe(
      mapRuntimeContextError(
        "runtime-control-plane.contexts.get",
        "failed to read runtime context row",
        contextId,
      ),
    )
    return yield* Option.match(maybeContext, {
      onNone: () =>
        Effect.fail(asRuntimeContextError(
          "runtime-control-plane.contexts.get",
          `runtime context not found: ${contextId}`,
          contextId,
        )),
      onSome: row => Effect.succeed(row),
    })
  })

const allocateRuntimeActivityAttempt = (
  context: RuntimeContext,
) =>
  // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.2
  Effect.gen(function* () {
    const runtimeRuns = yield* RuntimeRunAppendAndGet
    return yield* runtimeRuns.allocateActivityAttempt(context)
  }).pipe(
    mapRuntimeContextError(
      "runtime-control-plane.runs.allocate-attempt",
      "failed to allocate runtime activity attempt",
      context.contextId,
    ),
  )

const writeRunStarted = (
  context: RuntimeContext,
  activityAttempt: number,
) =>
  Effect.gen(function* () {
    const runtimeRuns = yield* RuntimeRunAppendAndGet
    yield* runtimeRuns.recordStarted(context, activityAttempt).pipe(
      mapRuntimeContextError(
        "runtime-control-plane.runs.started",
        "failed to append runtime started row",
        context.contextId,
      ),
    )
  })

const writeRunExited = (
  context: RuntimeContext,
  activityAttempt: number,
  exit: Schema.Schema.Type<typeof RuntimeExitEvidence>,
) =>
  Effect.gen(function* () {
    const runtimeRuns = yield* RuntimeRunAppendAndGet
    yield* runtimeRuns.recordExited(context, activityAttempt, exit).pipe(
      mapRuntimeContextError(
        "runtime-control-plane.runs.exited",
        "failed to append runtime exited row",
        context.contextId,
      ),
    )
  })

const writeRunFailed = (
  context: RuntimeContext,
  activityAttempt: number,
  message: string,
) =>
  Effect.gen(function* () {
    const runtimeRuns = yield* RuntimeRunAppendAndGet
    yield* runtimeRuns.recordFailed(context, activityAttempt, message).pipe(
      mapRuntimeContextError(
        "runtime-control-plane.runs.failed",
        "failed to append runtime failed row",
        context.contextId,
      ),
    )
  })

const runRuntimeContext = (
  context: RuntimeContext,
  activityAttempt: number,
) =>
  // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.3
  // firegrid-workflow-driven-runtime.BOUNDARIES.1
  Effect.gen(function* () {
    const hostConfig = yield* RuntimeHostConfig
    const appendEvent = yield* RuntimeEventAppendAndGet
    const appendLog = yield* RuntimeLogLineAppendAndGet
    const writeOutputChunk = (
      sequence: number,
      chunk: Extract<ProcessOutputChunk, { readonly type: "output" }>,
    ) =>
      outputRowFromProcessChunk(context, activityAttempt, sequence, chunk).pipe(
        Effect.flatMap((row) => {
          if (row.source === "stdout") {
            return appendEvent.append(row).pipe(Effect.asVoid)
          }
          return appendLog.append(row).pipe(Effect.asVoid)
        }),
        mapRuntimeContextError(
          "runtime-output.write",
          "failed to write runtime data-plane row",
          context.contextId,
        ),
      )

    const ingressTable = yield* RuntimeIngressTable
    const protocol = agentProtocolForContext(context)
    if (protocol !== "raw") {
      return yield* runCodecRuntimeContext({
        context,
        activityAttempt,
        protocol,
      })
    }

    const command = yield* commandForContext(context)
    const stdin = hostConfig.inputEnabled
      ? localProcessStdinDelivery({
        contextId: context.contextId,
        subscriberId: localProcessStdinSubscriberId,
      }).pipe(
        // firegrid-workflow-driven-runtime.BOUNDARIES.5
        Stream.mapError(cause =>
          asRuntimeContextError(
            `runtime-ingress.${cause.op}`,
            cause.message,
            context.contextId,
            cause,
          )),
        Stream.provideSomeLayer(RuntimeIngressAppenderLayer({
          currentContextId: context.contextId,
        })),
        Stream.provideSomeLayer(RuntimeIngressDeliveryTrackerLayer),
        Stream.provideService(RuntimeIngressTable, ingressTable),
      )
      : undefined

    return yield* streamSandboxProcess({
      labels: {
        firegridRuntimeContextId: context.contextId,
      },
      ...(context.runtime.config.cwd === undefined ? {} : { workingDir: context.runtime.config.cwd }),
      providerConfig: {
        contextId: context.contextId,
      },
      command: {
        ...command,
        ...(stdin === undefined ? {} : { stdin }),
      },
    }).pipe(
      Stream.mapError((cause: SandboxProviderError) =>
        asRuntimeContextError(`sandbox.${cause.op}`, cause.message, context.contextId, cause)),
      Stream.mapAccum(0, (sequence, chunk): readonly [number, SequencedChunk] => [
        sequence + 1,
        { sequence, chunk },
      ]),
      Stream.tap(({ chunk, sequence }) =>
        chunk.type === "exit"
          ? Effect.void
          // firegrid-durable-launch-runtime-operator.JOURNAL_ROWS.7
          : writeOutputChunk(sequence, chunk)),
      Stream.filter((item): item is SequencedChunk & {
        readonly sequence: number
        readonly chunk: Extract<ProcessOutputChunk, { readonly type: "exit" }>
      } => item.chunk.type === "exit"),
      Stream.runHead,
      Effect.flatMap(Option.match({
        onNone: () =>
          Effect.fail(asRuntimeContextError(
            "sandbox.stream",
            "process stream ended without an exit chunk",
            context.contextId,
          )),
        onSome: ({ chunk }) =>
          Effect.succeed({
            exitCode: chunk.exitCode,
            ...(chunk.signal === undefined ? {} : { signal: chunk.signal }),
          }),
      })),
    )
  })

const runRuntimeContextActivity = (
  context: RuntimeContext,
  activityAttempt: number,
) =>
  Activity.make({
    name: "firegrid.runtime-context.run",
    success: RuntimeExitEvidence,
    error: RuntimeContextError,
    execute: runRuntimeContext(context, activityAttempt).pipe(
      Effect.provide(RuntimeOutputJournalLayer),
    ),
  })

const RuntimeContextWorkflow = Workflow.make({
  name: "firegrid.runtime-context",
  payload: RuntimeContextWorkflowPayload,
  success: StartRuntimeResultSchema,
  error: RuntimeContextError,
  idempotencyKey: ({ contextId }) => runtimeContextWorkflowExecutionId(contextId),
})

const failAfterWritingRunFailed = (
  context: RuntimeContext,
  activityAttempt: number,
) =>
(error: RuntimeContextError) =>
  Effect.gen(function* () {
    yield* writeRunFailed(context, activityAttempt, error.message)
    return yield* Effect.fail(error)
  })

const RuntimeContextWorkflowLayer = RuntimeContextWorkflow.toLayer(({ contextId }) =>
  Effect.gen(function* () {
    // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.2
    const context = yield* readRuntimeContext(contextId)
    const activityAttempt = yield* allocateRuntimeActivityAttempt(context)
    yield* writeRunStarted(context, activityAttempt)
    const exit = yield* runRuntimeContextActivity(context, activityAttempt).pipe(
      Effect.catchAll(failAfterWritingRunFailed(context, activityAttempt)),
    )
    yield* writeRunExited(context, activityAttempt, exit).pipe(
      Effect.catchAll(failAfterWritingRunFailed(context, activityAttempt)),
    )
    return {
      contextId: context.contextId,
      activityAttempt,
      exitCode: exit.exitCode,
      ...(exit.signal === undefined ? {} : { signal: exit.signal }),
    }
  }))

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

const ownerIngressLayer = (
  options: {
    readonly baseUrl: string
    readonly headers?: DurableTableHeaders
    readonly context: RuntimeContext
  },
) =>
  RuntimeIngressTable.layer({
    streamOptions: {
      url: hostOwnedStreamUrl({
        baseUrl: options.baseUrl,
        prefix: options.context.host.streamPrefix,
        segment: "runtimeIngress",
      }),
      contentType: "application/json",
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
    },
  })

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
) =>
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
  const hostTables = Layer.mergeAll(
    hostOwnedIngressLayer(sharedOptions),
    hostOwnedOutputLayer(sharedOptions),
    hostOwnedWorkflowEngineLayer(sharedOptions),
  )
  return RuntimeObservationSourcesLive.pipe(
    Layer.provideMerge(HostOwnedDurableToolsWaitForLive),
    Layer.provideMerge(RuntimeOutputJournalLayer),
    Layer.provideMerge(RuntimeControlPlaneRecorderLive),
    Layer.provideMerge(RuntimeIngressInputStreamLayer),
    Layer.provideMerge(RuntimeIngressDeliveryTrackerLayer),
    Layer.provideMerge(hostTables),
  )
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
  return RuntimeContextWorkflowLayer.pipe(
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

// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.3
//
// RuntimeHostTopologyFromConfig reads only the base URL + namespace +
// optional input / token from env. Host identity is NOT an env knob:
// `FiregridRuntimeHostFromConfig` composes the resulting topology
// through `FiregridLocalHostLive`, which owns CurrentHostSession
// internally and derives the host id deterministically from the
// namespace. Multi-host topologies bypass FromConfig entirely and
// supply `hostId` at the programmatic composition boundary via
// `FiregridRuntimeHostWithWorkflowLive`.
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

export const FiregridRuntimeHostFromConfig = Layer.unwrapEffect(
  Effect.map(RuntimeHostTopologyFromConfig, options => FiregridLocalHostLive(options)),
)

export const FiregridRuntimeHostWithWorkflowFromConfig = Layer.unwrapEffect(
  Effect.map(RuntimeHostTopologyFromConfig, options => FiregridLocalHostLive(options)),
)

// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6
// Variant for callers that want to pass a non-default env resolver policy
// (e.g. firegrid:run, whose --secret-env flag authorizes specific host env
// vars). The policy is constructed at the binary boundary so that
// globalThis.process.env reads stay outside library code.
export const FiregridRuntimeHostWithWorkflowFromConfigWithEnvPolicy = (
  envPolicy: Layer.Layer<RuntimeEnvResolverPolicy>,
) =>
  Layer.unwrapEffect(
    Effect.map(RuntimeHostTopologyFromConfig, options =>
      FiregridLocalHostLive(options, envPolicy)),
  )

export const startRuntime = (
  options: StartRuntimeOptions,
) =>
  // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.1
  // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.4
  // firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.2
  // firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.4
  //
  // requireLocalContext runs before any host-owned services are
  // touched, so a host cannot smuggle execution of a context whose
  // RuntimeContext.host binding names another host. The check uses
  // RuntimeControlPlaneTable + CurrentHostSession from this same host
  // scope; it is not a tool-arg or env-var check.
  Effect.gen(function* () {
    yield* requireLocalContext(options.contextId)
    const engine = yield* WorkflowEngine.WorkflowEngine
    return yield* executeRuntimeContextWorkflow(engine, RuntimeContextWorkflow, {
      executionId: runtimeContextWorkflowExecutionId(options.contextId),
      payload: RuntimeContextWorkflowPayload.make({
        contextId: options.contextId,
      }),
    })
  }).pipe(
    Effect.withClock(runtimeExecutionClock),
  )

export const RuntimeStartCapabilityLive = Layer.effect(
  RuntimeStartCapability,
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine
    const controlPlane = yield* RuntimeControlPlaneTable
    const hostSession = yield* CurrentHostSession
    return RuntimeStartCapability.of({
      start: options =>
        startRuntime(options).pipe(
          Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
          Effect.provideService(RuntimeControlPlaneTable, controlPlane),
          Effect.provideService(CurrentHostSession, hostSession),
        ),
    })
  }),
)

export const appendRuntimeIngress = (
  request: RuntimeIngressRequest,
) =>
  Effect.gen(function* () {
    // firegrid-host-context-authority.PROMPT_ROUTING.1
    // firegrid-host-context-authority.PROMPT_ROUTING.2
    //
    // Prompt append is durable routing, not local process execution.
    // Resolve RuntimeContext through the namespace-scoped control
    // plane, then open the owner host's ingress table from
    // RuntimeContext.host. The caller never passes or constructs the
    // owner ingress URL.
    const context = yield* readRuntimeContext(request.contextId).pipe(
      Effect.mapError(cause =>
        runtimeIngressError(
          "append",
          "failed to resolve runtime context for ingress append",
          request.contextId,
          request.inputId,
          cause,
        )),
    )
    const options = yield* RuntimeHostConfig
    return yield* appendRuntimeIngressInCurrentContext(request).pipe(
      provideRuntimeContext(context),
      Effect.provide(RuntimeIngressAppenderLayer({
        currentContextId: context.contextId,
      })),
      Effect.provide(ownerIngressLayer({
        baseUrl: options.durableStreamsBaseUrl,
        ...(options.headers !== undefined ? { headers: options.headers } : {}),
        context,
      })),
      Effect.scoped,
    )
  })

const appendRuntimeIngressInCurrentContext = (
  request: RuntimeIngressRequest,
) =>
  Effect.gen(function* () {
    const appendIngress = yield* RuntimeIngressAppendAndGet
    return yield* appendIngress.append(request)
  }).pipe(
    Effect.mapError(cause =>
      runtimeIngressError(
        "append",
        "failed to append runtime ingress durable row",
        request.contextId,
        request.inputId,
        cause,
      )),
  )

const unsupportedAgentTool = (
  toolUseId: string,
  name: string,
) =>
  Effect.fail(toolExecutionFailed(
    toolUseId,
    name,
    new Error(`${name} is not wired by RuntimeHostAgentToolHostLive in this slice`),
  ))

const childContextIdForToolUse = (
  parentContextId: string,
  toolUseId: string,
) => {
  const segment = `${parentContextId}-${toolUseId}`.replaceAll(
    /[^A-Za-z0-9_-]/g,
    "_",
  )
  return `ctx_${segment}`
}

const sessionNewInputIdForToolUse = (
  childContextId: string,
  toolUseId: string,
) => `session-new:${childContextId}:${toolUseId}`

const runtimeHostAgentToolHostService = (captured: {
  readonly hostConfig: RuntimeHostConfig["Type"]
  readonly contextInsert: RuntimeContextInsertService
  readonly contextRead: RuntimeContextReadService
  readonly hostSession: HostSessionRow
  readonly workflowEngine: WorkflowEngine.WorkflowEngine["Type"]
}): AgentToolHostService => ({
  spawnChildContext: ({
    parentContextId,
    toolUseId,
    agentKind,
    prompt,
    spawnOptions,
  }) =>
    Effect.gen(function* () {
      const childContextId = childContextIdForToolUse(parentContextId, toolUseId)
      const intent = normalizeRuntimeIntent(local.jsonl({
        argv: [agentKind],
        ...(spawnOptions?.cwd === undefined ? {} : { cwd: spawnOptions.cwd }),
      }))
      // firegrid-factory-aligned-agent-tools.SESSION.1
      // firegrid-factory-aligned-agent-tools.SESSION.6
      yield* captured.contextInsert.insertLocalContext(intent, {
        contextId: childContextId,
        createdBy: `agent-tool:${parentContextId}`,
      })
      const inputId = sessionNewInputIdForToolUse(childContextId, toolUseId)
      yield* appendIngressWithHostCapabilities(captured, {
        contextId: childContextId,
        inputId,
        kind: "message",
        authoredBy: "workflow",
        payload: Prompt.userMessage({
          content: [Prompt.textPart({ text: prompt })],
        }),
        idempotencyKey: inputId,
      })
      yield* requireLocalContextWithHostCapabilities(captured, childContextId)
      yield* executeRuntimeContextWorkflow(
        captured.workflowEngine,
        RuntimeContextWorkflow,
        {
          executionId: runtimeContextWorkflowExecutionId(childContextId),
          payload: RuntimeContextWorkflowPayload.make({
            contextId: childContextId,
          }),
          discard: true,
        },
      ).pipe(Effect.withClock(runtimeExecutionClock))
      return {
        childContextId,
        status: "running" as const,
      }
    }).pipe(
      Effect.mapError(cause => toolExecutionFailed(toolUseId, "session_new", cause)),
    ),
  spawnChildContexts: ({ toolUseId }) => unsupportedAgentTool(toolUseId, "spawn_all"),
  executeSandboxTool: ({ toolUseId }) => unsupportedAgentTool(toolUseId, "execute"),
  executeSessionCapability: ({ toolUseId }) =>
    unsupportedAgentTool(toolUseId, "execute"),
  appendSessionPrompt: ({ toolUseId, sessionId, inputId, prompt }) =>
    // firegrid-factory-aligned-agent-tools.PROMPT_DISPATCH.2
    appendIngressWithHostCapabilities(captured, {
      contextId: sessionId,
      inputId,
      kind: "message",
      authoredBy: "workflow",
      payload: prompt,
      idempotencyKey: inputId,
    }).pipe(Effect.mapError(cause =>
      toolExecutionFailed(toolUseId, "session_prompt", cause))),
  cancelSession: ({ toolUseId }) =>
    unsupportedAgentTool(toolUseId, "session_cancel"),
  closeSession: ({ toolUseId }) =>
    unsupportedAgentTool(toolUseId, "session_close"),
  appendScheduledPrompt: ({ contextId, inputId, prompt }) =>
    // firegrid-host-context-authority.PROMPT_ROUTING.3
    appendIngressWithHostCapabilities(captured, {
      contextId,
      inputId,
      kind: "message",
      authoredBy: "workflow",
      payload: prompt,
      idempotencyKey: inputId,
    }).pipe(Effect.mapError(cause =>
      toolExecutionFailed(inputId, "schedule_me", cause))),
})

const readRuntimeContextWithHostCapabilities = (
  captured: {
    readonly contextRead: RuntimeContextReadService
  },
  contextId: string,
): Effect.Effect<RuntimeContext, RuntimeContextError> =>
  Effect.gen(function* () {
    const maybeContext = yield* captured.contextRead.readContext(contextId).pipe(
      mapRuntimeContextError(
        "runtime-control-plane.contexts.get",
        "failed to read runtime context row",
        contextId,
      ),
    )
    return yield* Option.match(maybeContext, {
      onNone: () =>
        Effect.fail(asRuntimeContextError(
          "runtime-control-plane.contexts.get",
          `runtime context not found: ${contextId}`,
          contextId,
        )),
      onSome: row => Effect.succeed(row),
    })
  })

const requireLocalContextWithHostCapabilities = (
  captured: {
    readonly contextRead: RuntimeContextReadService
    readonly hostSession: HostSessionRow
  },
  contextId: string,
): Effect.Effect<RuntimeContext, ContextNotLocal | RuntimeContextError> =>
  readRuntimeContextWithHostCapabilities(captured, contextId).pipe(
    Effect.flatMap(context =>
      context.host.hostId !== captured.hostSession.hostId
        ? Effect.fail(new ContextNotLocal({
          contextId,
          hostId: context.host.hostId,
          currentHostId: captured.hostSession.hostId,
        }))
        : Effect.succeed(context)),
  )

const appendIngressWithHostCapabilities = (
  captured: {
    readonly hostConfig: RuntimeHostConfig["Type"]
    readonly contextRead: RuntimeContextReadService
  },
  request: RuntimeIngressRequest,
) =>
  Effect.gen(function* () {
    const context = yield* readRuntimeContextWithHostCapabilities(
      captured,
      request.contextId,
    ).pipe(
      Effect.mapError(cause =>
        runtimeIngressError(
          "append",
          "failed to resolve runtime context for ingress append",
          request.contextId,
          request.inputId,
          cause,
        )),
    )
    return yield* appendRuntimeIngressInCurrentContext(request).pipe(
      provideRuntimeContext(context),
      Effect.provide(RuntimeIngressAppenderLayer({
        currentContextId: context.contextId,
      })),
      Effect.provide(ownerIngressLayer({
        baseUrl: captured.hostConfig.durableStreamsBaseUrl,
        ...(captured.hostConfig.headers === undefined ? {} : { headers: captured.hostConfig.headers }),
        context,
      })),
      Effect.scoped,
    )
  }).pipe(Effect.asVoid)

export const RuntimeHostAgentToolHostLive = Layer.effect(
  AgentToolHost,
  Effect.gen(function* () {
    const hostConfig = yield* RuntimeHostConfig
    const contextInsert = yield* RuntimeContextInsert
    const contextRead = yield* RuntimeContextRead
    const hostSession = yield* CurrentHostSession
    const workflowEngine = yield* WorkflowEngine.WorkflowEngine
    return runtimeHostAgentToolHostService({
      hostConfig,
      contextInsert,
      contextRead,
      hostSession,
      workflowEngine,
    })
  }),
)
