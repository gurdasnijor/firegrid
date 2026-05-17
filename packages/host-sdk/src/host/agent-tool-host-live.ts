import { Prompt } from "@effect/ai"
import { WorkflowEngine } from "@effect/workflow"
import {
  CurrentHostSession,
  local,
  normalizeRuntimeIntent,
  type HostSessionRow,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import type { RuntimeIngressRequest } from "@firegrid/protocol/runtime-ingress"
import { Effect, Layer } from "effect"
import {
  AgentToolHost,
  type AgentToolHostService,
} from "../agent-tools/execution/tool-host.ts"
import { toolExecutionFailed } from "../agent-tools/bindings/tool-error.ts"
import {
  RuntimeContextInsert,
  type RuntimeContextInsertService,
  RuntimeContextRead,
  type RuntimeContextReadService,
} from "@firegrid/runtime/host-substrate"
import {
  runtimeIngressError,
} from "@firegrid/runtime/host-substrate"
import type { RuntimeContextError } from "@firegrid/runtime/host-substrate"
import { RuntimeHostConfig } from "./config.ts"
import {
  appendRuntimeIngressToOwner,
} from "./commands.ts"
import {
  readRuntimeContextWithHostSession,
  requireLocalRuntimeContextWithHostSession,
  runtimeContextWorkflowExecutionId,
  runtimeExecutionClock,
} from "./internal/runtime-context-helpers.ts"
import { executeRuntimeContextWorkflow } from "./internal/run-context-workflow.ts"
import {
  RuntimeContextWorkflowNative,
  RuntimeContextWorkflowPayload,
} from "./runtime-context-workflow-core.ts"

// firegrid-runtime-boundary-reconciliation.HOST_SPLIT.3
// Host-coupled AgentToolHost live behavior lives here instead of the host
// public barrel.
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
        RuntimeContextWorkflowNative,
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
  readRuntimeContextWithHostSession(captured.contextRead, contextId)

const requireLocalContextWithHostCapabilities = (
  captured: {
    readonly contextRead: RuntimeContextReadService
    readonly hostSession: HostSessionRow
  },
  contextId: string,
): ReturnType<typeof requireLocalRuntimeContextWithHostSession> =>
  requireLocalRuntimeContextWithHostSession(
    captured.contextRead,
    captured.hostSession,
    contextId,
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
    return yield* appendRuntimeIngressToOwner(request, context, captured.hostConfig)
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
