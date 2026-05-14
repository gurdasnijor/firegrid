import { NodeContext } from "@effect/platform-node"
import {
  Activity,
  Workflow,
  WorkflowEngine,
} from "@effect/workflow"
import {
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  makeHostSessionRow,
  type HostSessionId,
  type RuntimeContext,
  type RuntimeEventRow,
  type RuntimeLogLineRow,
} from "@firegrid/protocol/launch"
import {
  RuntimeIngressTable,
  makeRuntimeIngressInputRow,
  type RuntimeIngressRequest,
} from "@firegrid/protocol/runtime-ingress"
import { Clock, Config, Effect, Layer, Option, Redacted, Schema, Stream } from "effect"
import type { DurableTableHeaders } from "effect-durable-operators"
import {
  CurrentHostSession,
  hostOwnedStreamUrl,
  requireLocalContext,
  runtimeControlPlaneStreamUrl,
} from "./host-context-authority.ts"
import { acquireStableHostId } from "./internal/host-id.ts"
import { executeRuntimeContextWorkflow } from "./internal/run-context-workflow.ts"
import {
  LocalProcessSandboxProvider,
  RuntimeEnvResolverPolicy,
  commandForContext,
  localProcessStdinDelivery,
  streamSandboxProcess,
  type ProcessOutputChunk,
  type SandboxProviderError,
} from "../providers/sandboxes/index.ts"
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
  insertLocalRuntimeContext,
  provideRuntimeContext,
  requireLocalContext,
  runtimeControlPlaneStreamUrl,
} from "./host-context-authority.ts"

export {
  RuntimeIngressError,
}
export {
  localProcessSpawnEnvFromHostEnv,
  type LocalProcessSandboxProviderOptions,
} from "../providers/sandboxes/local-process.ts"

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

const localProcessStdinSubscriberId = "runtime-context:local-process:stdin"

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

const readRuntimeContext = (
  contextId: string,
) =>
  Effect.gen(function* () {
    const table = yield* RuntimeControlPlaneTable
    const maybeContext = yield* table.contexts.get(contextId).pipe(
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
  Effect.flatMap(RuntimeControlPlaneTable, table =>
    table.runs.query((coll) => {
      const rows = coll.toArray.filter(row => row.contextId === context.contextId)
      const terminalAttempts = new Set(
        rows
          .filter(row => row.status === "exited" || row.status === "failed")
          .map(row => row.activityAttempt),
      )
      const inProgress = rows
        .filter(row => row.status === "started" && !terminalAttempts.has(row.activityAttempt))
        .map(row => row.activityAttempt)
        .sort((left, right) => left - right)[0]
      return inProgress ?? rows.reduce((max, row) => Math.max(max, row.activityAttempt + 1), 1)
    })).pipe(
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
    const table = yield* RuntimeControlPlaneTable
    const startedAt = yield* nowIso
    yield* table.runs.upsert({
      runEventId: {
        contextId: context.contextId,
        activityAttempt,
        status: "started",
      },
      contextId: context.contextId,
      activityAttempt,
      provider: context.runtime.provider,
      status: "started",
      at: startedAt,
    }).pipe(
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
    const table = yield* RuntimeControlPlaneTable
    const exitedAt = yield* nowIso
    yield* table.runs.upsert({
      runEventId: {
        contextId: context.contextId,
        activityAttempt,
        status: "exited",
      },
      contextId: context.contextId,
      activityAttempt,
      status: "exited",
      provider: context.runtime.provider,
      at: exitedAt,
      exitCode: exit.exitCode,
      ...(exit.signal === undefined ? {} : { signal: exit.signal }),
    }).pipe(
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
    const table = yield* RuntimeControlPlaneTable
    const failedAt = yield* nowIso
    yield* table.runs.upsert({
      runEventId: {
        contextId: context.contextId,
        activityAttempt,
        status: "failed",
      },
      contextId: context.contextId,
      activityAttempt,
      status: "failed",
      provider: context.runtime.provider,
      message,
      at: failedAt,
    }).pipe(
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
    const outputTable = yield* RuntimeOutputTable
    const writeOutputChunk = (
      sequence: number,
      chunk: Extract<ProcessOutputChunk, { readonly type: "output" }>,
    ) =>
      outputRowFromProcessChunk(context, activityAttempt, sequence, chunk).pipe(
        Effect.flatMap(row =>
          row.source === "stdout"
            ? outputTable.events.upsert(row)
            : outputTable.logs.upsert(row)),
        mapRuntimeContextError(
          "runtime-output.write",
          "failed to write runtime data-plane row",
          context.contextId,
        ),
      )

    const command = yield* commandForContext(context)
    const ingressTable = yield* RuntimeIngressTable
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
    execute: runRuntimeContext(context, activityAttempt),
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
const currentHostSessionLayer = (
  options: RuntimeHostTopologyOptions,
) =>
  Layer.effect(
    CurrentHostSession,
    Effect.gen(function* () {
      const startedAtMs = yield* Clock.currentTimeMillis
      // firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.3
      // Stable host id comes from options.hostId, FIREGRID_HOST_ID env,
      // or the persisted `$HOME/.firegrid/host-id` file (auto-created
      // on first run). The random-uuid path is encapsulated in
      // `runtime-host/internal/host-id.ts` so callers never see a
      // fresh-per-process id in the durable host binding.
      const hostId = yield* acquireStableHostId(options.hostId)
      const hostSessionId = (options.hostSessionId
        ?? `session-${crypto.randomUUID()}`) as HostSessionId
      return makeHostSessionRow({
        hostId,
        hostSessionId,
        namespace: options.namespace,
        startedAtMs,
      })
    }),
  ).pipe(Layer.provide(NodeContext.layer))

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
  return Layer.mergeAll(
    hostOwnedIngressLayer(sharedOptions),
    hostOwnedOutputLayer(sharedOptions),
    hostOwnedWorkflowEngineLayer(sharedOptions),
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
//
// FIREGRID_HOST_ID is the stable host identity — a restarted host
// adopts the same stream prefix and reconciles its own pending
// workflow clocks. When omitted V1 falls back to a fresh
// `host_<uuid>` per process, which is fine for short-lived smokes
// but means scheduled work does not survive restart. Operators
// should set FIREGRID_HOST_ID to a stable value (e.g. derived from
// a local host file or platform identity) for durable deployments.
//
// FIREGRID_HOST_SESSION_ID is per-process by design — even with a
// stable hostId, sessions can be distinguished for liveness work.
// V1 generates a fresh session id when omitted.
export const RuntimeHostTopologyFromConfig = Config.all({
  durableStreamsBaseUrl: Config.string("DURABLE_STREAMS_BASE_URL"),
  namespace: Config.string("FIREGRID_RUNTIME_NAMESPACE"),
  input: Config.boolean("FIREGRID_RUNTIME_INPUT_ENABLED").pipe(
    Config.withDefault(false),
  ),
  hostId: Config.option(Config.string("FIREGRID_HOST_ID")),
  hostSessionId: Config.option(Config.string("FIREGRID_HOST_SESSION_ID")),
  token: Config.option(Config.redacted("FIREGRID_DURABLE_STREAMS_TOKEN")),
}).pipe(
  Config.map(({ durableStreamsBaseUrl, namespace, input, hostId, hostSessionId, token }) => {
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
      ...Option.match(hostId, {
        onNone: () => ({}),
        onSome: (value) => ({ hostId: value }),
      }),
      ...Option.match(hostSessionId, {
        onNone: () => ({}),
        onSome: (value) => ({ hostSessionId: value }),
      }),
      ...(headers !== undefined ? { headers } : {}),
    }
  }),
)

export const FiregridRuntimeHostFromConfig = Layer.unwrapEffect(
  Effect.map(RuntimeHostTopologyFromConfig, options => FiregridRuntimeHostLive(options)),
)

export const FiregridRuntimeHostWithWorkflowFromConfig = Layer.unwrapEffect(
  Effect.map(RuntimeHostTopologyFromConfig, options => FiregridRuntimeHostWithWorkflowLive(options)),
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
      FiregridRuntimeHostWithWorkflowLive(options, envPolicy)),
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

export const appendRuntimeIngress = (
  request: RuntimeIngressRequest,
) =>
  Effect.gen(function* () {
    const options = yield* RuntimeHostConfig
    if (!options.inputEnabled) {
      return yield* runtimeIngressError(
        "append",
        "runtime ingress table is not configured",
        request.contextId,
        request.inputId,
      )
    }
    // firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.2
    //
    // In Slice 2 the host-owned ingress table is the local host's.
    // Cross-host prompt routing (writing to the owner host's ingress
    // through resolved RuntimeContext.host) is Slice 3. Until then a
    // foreign-context append would silently land on the wrong host's
    // ingress, so the operator rejects it loudly.
    yield* requireLocalContext(request.contextId).pipe(
      Effect.mapError(cause =>
        runtimeIngressError(
          "append",
          "runtime ingress append rejected by local-host authority",
          request.contextId,
          request.inputId,
          cause,
        )),
    )
    const table = yield* RuntimeIngressTable
    const row = makeRuntimeIngressInputRow(request)
    const existing = yield* table.inputs.get(row.inputId).pipe(
      Effect.mapError(cause =>
        runtimeIngressError(
          "append",
          "failed to read runtime ingress durable row",
          row.contextId,
          row.inputId,
          cause,
        )),
    )
    if (Option.isSome(existing)) {
      return existing.value
    }

    // firegrid-agent-ingress.INGRESS.9
    const nextSequence = yield* table.inputs.query((coll) =>
      coll.toArray
        .filter(candidate => candidate.contextId === row.contextId)
        .reduce(
          (max, candidate) =>
            candidate.sequence === undefined ? max : Math.max(max, candidate.sequence + 1),
          0,
        ),
    ).pipe(
      Effect.mapError(cause =>
        runtimeIngressError(
          "append",
          "failed to query runtime ingress durable rows",
          row.contextId,
          row.inputId,
          cause,
        )),
    )
    const sequenced = {
      ...row,
      status: "sequenced" as const,
      sequence: nextSequence,
      sequencedAt: yield* nowIso,
    }
    // firegrid-agent-ingress.INGRESS.10
    yield* table.inputs.insert(sequenced).pipe(
      Effect.mapError(cause =>
        runtimeIngressError(
          "append",
          "failed to append runtime ingress durable row",
          row.contextId,
          row.inputId,
          cause,
        )),
    )
    return sequenced
  })
