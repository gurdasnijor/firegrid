import { WorkflowEngine } from "@effect/workflow"
import {
  CurrentHostSession,
  RuntimeStartCapability,
  requireLocalContext,
} from "@firegrid/protocol/launch"
import {
  type RuntimeIngressRequest,
} from "@firegrid/protocol/runtime-ingress"
import { Effect, Layer } from "effect"
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
import {
  RuntimeContextRead,
} from "@firegrid/runtime/host-substrate"
import { runtimeIngressError } from "@firegrid/runtime/host-substrate"
import { appendRuntimeIngressToOwner as appendRuntimeIngressToOwnerInternal } from "./internal/runtime-ingress-owner.ts"
export { appendRuntimeIngressToOwner } from "./internal/runtime-ingress-owner.ts"

// firegrid-runtime-boundary-reconciliation.HOST_SPLIT.4
// Command handlers remain thin entrypoints over workflow and ingress
// capabilities; host topology lives in layers.ts.
const executeRuntimeContextWorkflowForContextId = (
  engine: WorkflowEngine.WorkflowEngine["Type"],
  contextId: string,
) =>
  executeRuntimeContextWorkflow(engine, RuntimeContextWorkflowNative, {
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
    return yield* appendRuntimeIngressToOwnerInternal(request, context, options)
  })
