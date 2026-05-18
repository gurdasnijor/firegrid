import { Prompt } from "@effect/ai"
import {
  CurrentHostSession,
  RuntimeControlPlaneTable,
  local,
  normalizeRuntimeIntent,
  type HostSessionRow,
} from "@firegrid/protocol/launch"
import type { RuntimeIngressRequest } from "@firegrid/protocol/runtime-ingress"
import { type Context, Effect, Layer } from "effect"
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
} from "@firegrid/runtime/control-plane"
import {
  appendRuntimeIngress,
} from "./commands.ts"
import {
  requireLocalRuntimeContextWithHostSession,
  runtimeContextWorkflowExecutionId,
  runtimeExecutionClock,
} from "./internal/runtime-context-helpers.ts"
import type { HostRuntimeContextExecutionEnv } from "./runtime-substrate.ts"
import {
  RuntimeContextEngineRegistry,
} from "./runtime-context-engine-registry.ts"
import { executeRuntimeContextWorkflow } from "./internal/run-context-workflow.ts"
import {
  RuntimeContextWorkflowNative,
  RuntimeContextWorkflowPayload,
} from "./runtime-context-workflow-core.ts"
import {
  runtimeContextWorkflowSupportLayer,
} from "./runtime-context-workflow-support.ts"

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
  readonly contextInsert: RuntimeContextInsertService
  readonly contextRead: RuntimeContextReadService
  readonly hostSession: HostSessionRow
  readonly controlTable: RuntimeControlPlaneTable["Type"]
  readonly registry: RuntimeContextEngineRegistry["Type"]
  readonly agentToolHost: AgentToolHostService
  // TFIND-031: ambient host durable substrate captured at layer-build
  // time, re-provided into the deferred child-context workflow run.
  readonly hostContext: Context.Context<HostRuntimeContextExecutionEnv>
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
      yield* startChildContextWorkflow(captured, childContextId)
      return {
        childContextId,
        status: "running" as const,
      }
    }).pipe(
      // TFIND-031: discharge the host durable substrate the deferred
      // child-context workflow genuinely needs (RuntimeControlPlaneTable
      // / RuntimeOutputTable / DurableWait* / RuntimeHostConfig /
      // CurrentHostSession). Always satisfied at runtime by the composed
      // host layer; `any` previously hid the requirement.
      Effect.provide(captured.hostContext),
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
})

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
    readonly contextRead: RuntimeContextReadService
    readonly controlTable: RuntimeControlPlaneTable["Type"]
    readonly registry: RuntimeContextEngineRegistry["Type"]
  },
  request: RuntimeIngressRequest,
) =>
  appendRuntimeIngress(request).pipe(
    Effect.provideService(RuntimeContextRead, captured.contextRead),
    Effect.provideService(RuntimeControlPlaneTable, captured.controlTable),
    Effect.provideService(
      RuntimeContextEngineRegistry,
      captured.registry,
    ),
    Effect.asVoid,
  )

const startChildContextWorkflow = (
  captured: {
    readonly contextRead: RuntimeContextReadService
    readonly hostSession: HostSessionRow
    readonly registry: RuntimeContextEngineRegistry["Type"]
    readonly agentToolHost: AgentToolHostService
  },
  contextId: string,
) =>
  Effect.gen(function*() {
    const context = yield* requireLocalContextWithHostCapabilities(captured, contextId)
    const handle = yield* captured.registry.claimActive(context)
    yield* captured.registry.reconcile(context)
    yield* executeRuntimeContextWorkflow(
      handle.engine,
      RuntimeContextWorkflowNative,
      {
        executionId: runtimeContextWorkflowExecutionId(contextId),
        payload: RuntimeContextWorkflowPayload.make({ contextId }),
        discard: true,
      },
    ).pipe(
      Effect.provide(runtimeContextWorkflowSupportLayer(handle, captured.agentToolHost)),
      Effect.withClock(runtimeExecutionClock),
    )
  })

export const RuntimeHostAgentToolHostLive = Layer.effect(
  AgentToolHost,
  Effect.gen(function* () {
    const contextInsert = yield* RuntimeContextInsert
    const contextRead = yield* RuntimeContextRead
    const hostSession = yield* CurrentHostSession
    const controlTable = yield* RuntimeControlPlaneTable
    const registry = yield* RuntimeContextEngineRegistry
    // TFIND-031: capture the ambient host durable substrate so the
    // deferred child-context workflow (run later, outside this gen) can
    // re-provide it. Always present here via the composed host layer.
    const hostContext = yield* Effect.context<HostRuntimeContextExecutionEnv>()
    const service: AgentToolHostService = runtimeHostAgentToolHostService({
      contextInsert,
      contextRead,
      hostSession,
      controlTable,
      registry,
      hostContext,
      get agentToolHost() {
        return service
      },
    })
    return service
  }),
)
