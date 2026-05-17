import { WorkflowEngine } from "@effect/workflow"
import {
  CurrentHostSession,
  RuntimeStartCapability,
  hostOwnedStreamUrl,
  requireLocalContext,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import {
  type RuntimeIngressInputRow,
  type RuntimeIngressRequest,
} from "@firegrid/protocol/runtime-ingress"
import { Effect, Layer } from "effect"
import type { DurableTableError, DurableTableHeaders } from "effect-durable-operators"
import { RuntimeHostConfig } from "./config.ts"
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
  RuntimeIngressError,
  runtimeIngressError,
} from "@firegrid/runtime/errors"
import { DurableStreamsWorkflowEngine } from "@firegrid/runtime/workflow-engine"
import type { WorkflowEngineTable } from "@firegrid/runtime/workflow-engine"
import { appendRuntimeInputDeferred } from "./runtime-input-deferred.ts"

const executeRuntimeContextWorkflowForContextId = (
  engine: WorkflowEngine.WorkflowEngine["Type"],
  contextId: string,
) =>
  Effect.gen(function*() {
    const result = yield* executeRuntimeContextWorkflow(engine, RuntimeContextWorkflowNative, {
      executionId: runtimeContextWorkflowExecutionId(contextId),
      payload: RuntimeContextWorkflowPayload.make({
        contextId,
      }),
    })
    if (result.failure !== undefined) return yield* Effect.fail(result.failure)
    return result
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
    yield* requireLocalContext(options.contextId)
    const engine = yield* WorkflowEngine.WorkflowEngine
    return yield* executeRuntimeContextWorkflowForContextId(engine, options.contextId)
  }).pipe(
    Effect.withClock(runtimeExecutionClock),
  )

export const RuntimeStartCapabilityLive = Layer.effect(
  RuntimeStartCapability,
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine
    const contextRead = yield* RuntimeContextRead
    const hostSession = yield* CurrentHostSession
    return RuntimeStartCapability.of({
      start: options =>
        Effect.gen(function* () {
          yield* requireLocalRuntimeContextWithHostSession(
            contextRead,
            hostSession,
            options.contextId,
          )
          return yield* executeRuntimeContextWorkflowForContextId(engine, options.contextId)
        }).pipe(
          Effect.withClock(runtimeExecutionClock),
        ),
    })
  }),
)

export const appendRuntimeIngress = (
  request: RuntimeIngressRequest,
): Effect.Effect<RuntimeIngressInputRow, RuntimeIngressError, RuntimeContextRead | RuntimeHostConfig> =>
  Effect.gen(function* () {
    // firegrid-host-context-authority.PROMPT_ROUTING.1
    // firegrid-host-context-authority.PROMPT_ROUTING.2
    //
    // Prompt append is durable routing, not local process execution.
    // Resolve RuntimeContext through the namespace-scoped control plane,
    // then complete the owner workflow's input deferred. The caller never
    // passes or constructs owner host stream URLs.
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
    return yield* appendRuntimeIngressToOwner(request, context, options)
  })

export const appendRuntimeIngressToOwner = (
  request: RuntimeIngressRequest,
  context: RuntimeContext,
  options: RuntimeHostConfig["Type"],
): Effect.Effect<RuntimeIngressInputRow, RuntimeIngressError> =>
  appendRuntimeIngressToWorkflow(request, context).pipe(
    Effect.provide(ownerWorkflowEngineLayer({
      baseUrl: options.durableStreamsBaseUrl,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      context,
    })),
    Effect.scoped,
    Effect.mapError(cause =>
      cause instanceof RuntimeIngressError ? cause : runtimeIngressError(
        "append",
        "failed to append runtime ingress deferred input to owner workflow",
        request.contextId,
        request.inputId,
        cause,
      )),
  )

const ownerWorkflowEngineLayer = (
  options: {
    readonly baseUrl: string
    readonly headers?: DurableTableHeaders
    readonly context: RuntimeContext
  },
): Layer.Layer<WorkflowEngine.WorkflowEngine | WorkflowEngineTable, DurableTableError> =>
  DurableStreamsWorkflowEngine.layer({
    streamUrl: hostOwnedStreamUrl({
      baseUrl: options.baseUrl,
      prefix: options.context.host.streamPrefix,
      segment: "workflow",
    }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  })

const appendRuntimeIngressToWorkflow = (
  request: RuntimeIngressRequest,
  context: RuntimeContext,
): Effect.Effect<
  RuntimeIngressInputRow,
  RuntimeIngressError,
  WorkflowEngine.WorkflowEngine | WorkflowEngineTable
> =>
  Effect.gen(function*() {
    return yield* appendRuntimeInputDeferred(request, context).pipe(
      Effect.mapError(cause =>
        runtimeIngressError(
          "append",
          "failed to append runtime ingress deferred input",
          request.contextId,
          request.inputId,
          cause,
        )),
    )
  })
