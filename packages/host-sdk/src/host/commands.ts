import {
  CurrentHostSession,
  RuntimeControlPlaneTable,
  RuntimeStartCapability,
  requireLocalContext,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import {
  makeRuntimeIngressInputRow,
  makeRuntimeInputIntentRow,
  type RuntimeIngressInputRow,
  type RuntimeIngressRequest,
  type RuntimeInputIntentRow,
} from "@firegrid/protocol/runtime-ingress"
import { Duration, Effect, Layer, Stream } from "effect"
import type { StartRuntimeOptions } from "./types.ts"
import {
  readRuntimeContext,
  requireLocalRuntimeContextWithHostSession,
  runtimeExecutionClock,
} from "@firegrid/runtime/kernel"
import { RuntimeContextRead } from "@firegrid/runtime/control-plane"
import {
  runtimeIngressError,
  type RuntimeIngressError,
} from "@firegrid/runtime/errors"
import {
  RuntimeContextWorkflowRuntime,
} from "@firegrid/runtime/kernel"
import {
  AgentToolHost,
  type AgentToolHostService,
} from "../agent-tools/execution/tool-host.ts"
import {
  makeRuntimeContextExitSignal,
  runtimeContextAwaitExit,
  runtimeContextWorkflowSupportLayer,
} from "./runtime-context-workflow-support.ts"
import type { HostRuntimeContextExecutionEnv } from "./runtime-substrate.ts"
import type { RuntimeChannelRouter } from "./channel.ts"

type RuntimeIngressAppendEnvironment =
  | RuntimeContextRead
  | RuntimeControlPlaneTable

const runtimeControlPlaneTable: Effect.Effect<
  RuntimeControlPlaneTable["Type"],
  never,
  RuntimeControlPlaneTable
> = RuntimeControlPlaneTable

// sidecar/shape-c-host-composition: Shape C cutover. The Shape C subscriber
// lives in `runtimeContextWorkflowSupportLayer`'s scope, so the run's `effect`
// only needs to hold the run-scope open until external interrupt (context
// deregister / host shutdown). Replaces the OLD
// `executeRuntimeContextWorkflowForContextId` driver and the
// `executeRuntimeContextWorkflow` engine call — neither has any consumer left
// on this branch.

const claimAndRunRuntimeContextWorkflow = (
  context: RuntimeContext,
  runtime: RuntimeContextWorkflowRuntime["Type"],
  agentToolHost: AgentToolHostService,
) =>
  Effect.gen(function*() {
    yield* Effect.annotateCurrentSpan({
      "firegrid.context.id": context.contextId,
      "firegrid.runtime.agent": context.runtime.config.agent ?? "",
      "firegrid.runtime.agent_protocol": context.runtime.config.agentProtocol ?? "",
      "firegrid.runtime_context_mcp.enabled": context.runtime.config.runtimeContextMcp?.enabled === true,
      "firegrid.runtime.shape": "C",
    })
    const exitSignal = yield* makeRuntimeContextExitSignal
    return yield* runtime.run({
      context,
      workflowName: "firegrid.runtime-context.shape-c",
      supportLayer: runtimeContextWorkflowSupportLayer(context, agentToolHost, exitSignal),
      effect: runtimeContextAwaitExit(exitSignal),
      deregisterOnExit: true,
    })
  }).pipe(
    Effect.withClock(runtimeExecutionClock),
    Effect.withSpan("firegrid.host.runtime_context.claim_and_run", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": context.contextId,
      },
    }),
    Effect.annotateSpans("firegrid.side", "host"),
  )

const insertRuntimeInputIntent = (
  request: RuntimeIngressRequest,
  control: RuntimeControlPlaneTable["Type"],
): Effect.Effect<RuntimeInputIntentRow, RuntimeIngressError> =>
  Effect.gen(function*() {
    const intent = makeRuntimeInputIntentRow(request)
    const stored = yield* control.inputIntents.insertOrGet(intent).pipe(
      Effect.mapError(cause =>
        runtimeIngressError(
          "append",
          "failed to append runtime input intent",
          request.contextId,
          request.inputId,
          cause,
        )),
    )
    return stored._tag === "Found" ? stored.row : intent
  })

// tf-2osu: bounded "context materialized" barrier for host ops that require a
// local context (startRuntime, appendRuntimeIngress). The CLI used to gate
// these with the public client `whenReady`; that primitive is deleted, so the
// host op owns its own readiness. createOrLoad writes a context-request row
// that the reconciler materializes asynchronously, so we wait on the contexts
// projection stream until the row appears, bounded. On timeout we simply
// proceed and the caller's existing requireLocalContext / readRuntimeContext
// surfaces the real not-found error (no behavior change for an
// already-materialized context — the stream yields it immediately — and no
// fast-fail regression for a genuinely absent one, only a bounded wait first).
const contextMaterializationTimeout = Duration.seconds(30)

const awaitContextMaterialized = (
  contextId: string,
): Effect.Effect<void, never, RuntimeControlPlaneTable> =>
  Effect.gen(function*() {
    const control = yield* runtimeControlPlaneTable
    // Subscription-driven (NOT fixed polling): the contexts projection stream
    // emits current rows + live changes, so we wait for the first row matching
    // this contextId. Bounded by an explicit deadline.
    yield* control.contexts.rows().pipe(
      Stream.filter(context => context.contextId === contextId),
      Stream.runHead,
      Effect.timeout(contextMaterializationTimeout),
      // On timeout (never materialized) or a transient stream error, proceed —
      // the caller's require/read step surfaces the authoritative error.
      Effect.ignore,
    )
  })

const readRuntimeContextForIngress = (
  request: RuntimeIngressRequest,
): Effect.Effect<void, RuntimeIngressError, RuntimeContextRead> =>
  readRuntimeContext(request.contextId).pipe(
    Effect.mapError(cause =>
      runtimeIngressError(
        "append",
        "failed to resolve runtime context for ingress append",
        request.contextId,
        request.inputId,
        cause,
      )),
    Effect.asVoid,
  )

const makePendingRuntimeIngressInput = (
  request: RuntimeIngressRequest,
  row: RuntimeInputIntentRow,
): RuntimeIngressInputRow =>
  makeRuntimeIngressInputRow(request, {
    inputId: row.intentId,
    createdAt: row.createdAt,
  })

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
    // tf-2osu: own the readiness barrier instead of relying on a caller-side
    // whenReady. Bounded; no-op once the context is materialized.
    yield* awaitContextMaterialized(options.contextId)
    const context = yield* requireLocalContext(options.contextId)
    const runtime = yield* RuntimeContextWorkflowRuntime
    const agentToolHost = yield* AgentToolHost
    return yield* claimAndRunRuntimeContextWorkflow(context, runtime, agentToolHost)
  }).pipe(
    Effect.withSpan("firegrid.host.runtime_context.start", {
      kind: "server",
      attributes: {
        "firegrid.context.id": options.contextId,
      },
    }),
    Effect.annotateSpans("firegrid.side", "host"),
  )

export const RuntimeStartCapabilityLive = Layer.effect(
  RuntimeStartCapability,
  Effect.gen(function* () {
    // TFIND-031: capture the host durable substrate (always provided by
    // the composed Firegrid host layer) so the deferred `start` closure
    // can re-provide it. `never` here was only sound while
    // `DurableTable.layer` leaked `any`.
    const captured = yield* Effect.context<
      HostRuntimeContextExecutionEnv | RuntimeChannelRouter
    >()
    const contextRead = yield* RuntimeContextRead
    const hostSession = yield* CurrentHostSession
    const runtime = yield* RuntimeContextWorkflowRuntime
    const agentToolHost = yield* AgentToolHost
    return RuntimeStartCapability.of({
      start: options =>
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan({
            "firegrid.context.id": options.contextId,
          })
          const context = yield* requireLocalRuntimeContextWithHostSession(
            contextRead,
            hostSession,
            options.contextId,
          )
          const result = yield* claimAndRunRuntimeContextWorkflow(context, runtime, agentToolHost).pipe(
            Effect.provide(captured),
          )
          return {
            contextId: context.contextId,
            activityAttempt: result.activityAttempt,
            exitCode: result.exitCode,
            ...(result.signal === undefined ? {} : { signal: result.signal }),
          }
        }).pipe(
          Effect.withSpan("firegrid.host.runtime_start_capability.start", {
            kind: "server",
            attributes: {
              "firegrid.context.id": options.contextId,
            },
          }),
          Effect.annotateSpans("firegrid.side", "host"),
        ),
    })
  }),
)

export const appendRuntimeIngress = (
  request: RuntimeIngressRequest,
): Effect.Effect<RuntimeIngressInputRow, RuntimeIngressError, RuntimeIngressAppendEnvironment> =>
  // tf-2osu: own the readiness barrier (bounded) before requiring the context;
  // the CLI no longer gates this with whenReady.
  awaitContextMaterialized(request.contextId).pipe(
    Effect.zipRight(readRuntimeContextForIngress(request)),
    Effect.zipRight(runtimeControlPlaneTable),
    Effect.flatMap(control => insertRuntimeInputIntent(request, control)),
    Effect.map(row => makePendingRuntimeIngressInput(request, row)),
  )
