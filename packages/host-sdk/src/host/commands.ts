import { WorkflowEngine } from "@effect/workflow"
import {
  CurrentHostSession,
  RuntimeStartCapability,
  hostOwnedStreamUrl,
  provideRuntimeContext,
  requireLocalContext,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import {
  RuntimeIngressTable,
  type RuntimeIngressRequest,
} from "@firegrid/protocol/runtime-ingress"
import { Effect, Layer } from "effect"
import type { DurableTableHeaders } from "effect-durable-operators"
import { RuntimeHostConfig } from "./config.ts"
import { executeRuntimeContextWorkflow } from "./internal/run-context-workflow.ts"
import type { StartRuntimeOptions } from "./types.ts"
import {
  RuntimeContextWorkflow,
  RuntimeContextWorkflowPayload,
} from "./runtime-context-workflow.ts"
import {
  readRuntimeContext,
  requireLocalRuntimeContextWithHostSession,
  runtimeContextWorkflowExecutionId,
  runtimeExecutionClock,
} from "./internal/runtime-context-helpers.ts"
import {
  RuntimeContextRead,
} from "@firegrid/runtime"
import {
  RuntimeIngressAppendAndGet,
  RuntimeIngressAppenderLayer,
} from "@firegrid/runtime"
import { runtimeIngressError } from "@firegrid/runtime"

// firegrid-runtime-boundary-reconciliation.HOST_SPLIT.4
// Command handlers remain thin entrypoints over workflow and ingress
// capabilities; host topology lives in layers.ts.
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

const executeRuntimeContextWorkflowForContextId = (
  engine: WorkflowEngine.WorkflowEngine["Type"],
  contextId: string,
) =>
  executeRuntimeContextWorkflow(engine, RuntimeContextWorkflow, {
    executionId: runtimeContextWorkflowExecutionId(contextId),
    payload: RuntimeContextWorkflowPayload.make({
      contextId,
    }),
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
    return yield* appendRuntimeIngressToOwner(request, context, options)
  })

export const appendRuntimeIngressToOwner = (
  request: RuntimeIngressRequest,
  context: RuntimeContext,
  options: RuntimeHostConfig["Type"],
) =>
  appendRuntimeIngressInCurrentContext(request).pipe(
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
