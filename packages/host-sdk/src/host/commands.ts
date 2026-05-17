import { Prompt } from "@effect/ai"
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
  type RuntimeIngressInputRow,
  type RuntimeIngressRequest,
} from "@firegrid/protocol/runtime-ingress"
import { Effect, Either, Layer, Schema } from "effect"
import type { DurableTableHeaders } from "effect-durable-operators"
import { RuntimeHostConfig } from "./config.ts"
import { executeRuntimeContextWorkflow } from "./internal/run-context-workflow.ts"
import type { StartRuntimeOptions } from "./types.ts"
import {
  RuntimeContextWorkflowNative,
  RuntimeContextWorkflowPayload,
  RuntimeContextWorkflowSession,
} from "./runtime-context-workflow-core.ts"
import {
  readRuntimeContext,
  requireLocalRuntimeContextWithHostSession,
  runtimeContextWorkflowExecutionId,
  runtimeExecutionClock,
} from "./internal/runtime-context-helpers.ts"
import {
  RuntimeContextRead,
  RuntimeRunAppendAndGet,
} from "@firegrid/runtime/control-plane"
import {
  RuntimeIngressAppendAndGet,
  RuntimeIngressAppenderLayer,
} from "@firegrid/runtime/runtime-ingress"
import { runtimeIngressError } from "@firegrid/runtime/errors"
import {
  AgentInputEventSchema,
  type AgentInputEvent,
} from "@firegrid/runtime/events"

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

class RuntimeIngressAgentInputTransformError extends Schema.TaggedError<
  RuntimeIngressAgentInputTransformError
>()("RuntimeIngressAgentInputTransformError", {
  op: Schema.String,
  contextId: Schema.String,
  inputId: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

const transformError = (
  row: RuntimeIngressInputRow,
  message: string,
  cause?: unknown,
): RuntimeIngressAgentInputTransformError =>
  new RuntimeIngressAgentInputTransformError({
    op: "runtime-ingress.agent-input.decode",
    contextId: row.contextId,
    inputId: row.inputId,
    message,
    ...(cause === undefined ? {} : { cause }),
  })

const textFromIngressPayload = (payload: unknown): string | undefined => {
  if (typeof payload === "string") return payload
  if (typeof payload !== "object" || payload === null) return undefined
  const record = payload as Record<string, unknown>
  return record.type === "text" && typeof record.text === "string"
    ? record.text
    : undefined
}

const promptFromIngressPayload = (
  row: RuntimeIngressInputRow,
): Effect.Effect<Extract<AgentInputEvent, { readonly _tag: "Prompt" }>, RuntimeIngressAgentInputTransformError> => {
  const text = textFromIngressPayload(row.payload)
  if (text !== undefined) {
    return Effect.succeed({
      _tag: "Prompt",
      correlationId: row.inputId,
      prompt: Prompt.userMessage({
        content: [Prompt.textPart({ text })],
      }),
    })
  }
  return Schema.decodeUnknown(Prompt.UserMessage)(row.payload).pipe(
    Effect.map(prompt => ({
      _tag: "Prompt" as const,
      correlationId: row.inputId,
      prompt,
    })),
    Effect.mapError(cause =>
      transformError(
        row,
        "runtime message ingress payload is not an AgentInputEvent, text payload, or Prompt.UserMessage",
        cause,
      )),
  )
}

const agentInputEventFromRuntimeIngressRow = (
  row: RuntimeIngressInputRow,
): Effect.Effect<AgentInputEvent, RuntimeIngressAgentInputTransformError> => {
  const decoded = Schema.decodeUnknownEither(AgentInputEventSchema)(row.payload)
  if (Either.isRight(decoded)) return Effect.succeed(decoded.right)

  if (row.kind === "message") return promptFromIngressPayload(row)

  if (row.kind === "tool_result") {
    return Schema.decodeUnknown(Prompt.ToolResultPart)(row.payload).pipe(
      Effect.map(part => ({ _tag: "ToolResult" as const, part })),
      Effect.mapError(cause =>
        transformError(
          row,
          "runtime tool_result ingress payload is not an AgentInputEvent or Prompt.ToolResultPart",
          cause,
        )),
    )
  }

  return Effect.fail(transformError(
    row,
    `runtime ${row.kind} ingress payload is not an AgentInputEvent`,
    decoded.left,
  ))
}

const sendRuntimeIngressToNativeSession = (
  context: RuntimeContext,
  row: RuntimeIngressInputRow,
) =>
  Effect.gen(function*() {
    const event = yield* agentInputEventFromRuntimeIngressRow(row)
    const runs = yield* RuntimeRunAppendAndGet
    const activityAttempt = yield* runs.allocateActivityAttempt(context)
    const session = yield* RuntimeContextWorkflowSession
    yield* session.send(context, activityAttempt, {
      _tag: "AgentInput",
      commandId: `runtime-input-${context.contextId}-${row.inputId}`,
      event,
    })
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
  Effect.gen(function*() {
    const row = yield* appendRuntimeIngressInCurrentContext(request)
    yield* sendRuntimeIngressToNativeSession(context, row)
    return row
  }).pipe(
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
