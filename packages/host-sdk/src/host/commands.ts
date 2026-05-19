import type { WorkflowEngine } from "@effect/workflow"
import {
  CurrentHostSession,
  RuntimeControlPlaneTable,
  RuntimeStartCapability,
  requireLocalContext,
} from "@firegrid/protocol/launch"
import {
  makeRuntimeIngressInputRow,
  makeRuntimeInputIntentRow,
  type RuntimeIngressInputRow,
  type RuntimeIngressRequest,
  type RuntimeInputIntentRow,
} from "@firegrid/protocol/runtime-ingress"
import { Effect, Layer } from "effect"
import { executeRuntimeContextWorkflow } from "./internal/run-context-workflow.ts"
import type { StartRuntimeOptions } from "./types.ts"
import {
  RuntimeContextWorkflowNative,
  RuntimeContextWorkflowPayload,
} from "./runtime-context-workflow-core.ts"
import {
  readRuntimeContext,
  requireLocalRuntimeContextWithHostSession,
  runtimeContextWorkflowExecutionId,
  runtimeExecutionClock,
} from "./internal/runtime-context-helpers.ts"
import { RuntimeContextRead } from "@firegrid/runtime/control-plane"
import {
  runtimeIngressError,
  type RuntimeIngressError,
} from "@firegrid/runtime/errors"
import {
  RuntimeContextEngineRegistry,
} from "./runtime-context-engine-registry.ts"
import {
  AgentToolHost,
  type AgentToolHostService,
} from "../agent-tools/execution/tool-host.ts"
import {
  runtimeContextWorkflowSupportLayer,
} from "./runtime-context-workflow-support.ts"
import type { HostRuntimeContextExecutionEnv } from "./runtime-substrate.ts"

type RuntimeIngressAppendEnvironment =
  | RuntimeContextRead
  | RuntimeControlPlaneTable

const runtimeControlPlaneTable: Effect.Effect<
  RuntimeControlPlaneTable["Type"],
  never,
  RuntimeControlPlaneTable
> = RuntimeControlPlaneTable

const executeRuntimeContextWorkflowForContextId = (
  engine: WorkflowEngine.WorkflowEngine["Type"],
  contextId: string,
) =>
  Effect.gen(function*() {
    yield* Effect.annotateCurrentSpan({
      "firegrid.context.id": contextId,
      "firegrid.workflow.name": RuntimeContextWorkflowNative.name,
      "firegrid.workflow.execution_id": runtimeContextWorkflowExecutionId(contextId),
    })
    const result = yield* executeRuntimeContextWorkflow(engine, RuntimeContextWorkflowNative, {
      executionId: runtimeContextWorkflowExecutionId(contextId),
      payload: RuntimeContextWorkflowPayload.make({
        contextId,
      }),
    })
    if (result.failure !== undefined) return yield* Effect.fail(result.failure)
    return result
  }).pipe(
    Effect.withSpan("firegrid.host.runtime_context.workflow.execute", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": contextId,
      },
    }),
    Effect.annotateSpans("firegrid.side", "host"),
  )

const claimAndRunRuntimeContextWorkflow = (
  context: Parameters<RuntimeContextEngineRegistry["Type"]["claimActive"]>[0],
  registry: RuntimeContextEngineRegistry["Type"],
  agentToolHost: AgentToolHostService,
) =>
  Effect.gen(function*() {
    yield* Effect.annotateCurrentSpan({
      "firegrid.context.id": context.contextId,
      "firegrid.runtime.agent": context.runtime.config.agent ?? "",
      "firegrid.runtime.agent_protocol": context.runtime.config.agentProtocol ?? "",
      "firegrid.runtime_context_mcp.enabled": context.runtime.config.runtimeContextMcp?.enabled === true,
    })
    const handle = yield* registry.claimActive(context)
    yield* registry.reconcile(context)
    return yield* executeRuntimeContextWorkflowForContextId(handle.engine, context.contextId).pipe(
      Effect.provide(runtimeContextWorkflowSupportLayer(handle, agentToolHost)),
      Effect.ensuring(registry.deregister(context.contextId)),
    )
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
    const context = yield* requireLocalContext(options.contextId)
    const registry = yield* RuntimeContextEngineRegistry
    const agentToolHost = yield* AgentToolHost
    return yield* claimAndRunRuntimeContextWorkflow(context, registry, agentToolHost)
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
    const captured = yield* Effect.context<HostRuntimeContextExecutionEnv>()
    const contextRead = yield* RuntimeContextRead
    const hostSession = yield* CurrentHostSession
    const registry = yield* RuntimeContextEngineRegistry
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
          return yield* claimAndRunRuntimeContextWorkflow(context, registry, agentToolHost).pipe(
            Effect.provide(captured),
          )
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
  readRuntimeContextForIngress(request).pipe(
    Effect.zipRight(runtimeControlPlaneTable),
    Effect.flatMap(control => insertRuntimeInputIntent(request, control)),
    Effect.map(row => makePendingRuntimeIngressInput(request, row)),
  )
