import { Prompt } from "@effect/ai"
import { WorkflowEngine } from "@effect/workflow"
import {
  CurrentHostSession,
  RuntimeControlPlaneTable,
  local,
  makeRuntimeLifecycleRequestRow,
  normalizeRuntimeIntent,
  runtimeControlPlaneStreamUrl,
  type HostSessionRow,
} from "@firegrid/protocol/launch"
import { RuntimeHostConfig } from "./config.ts"
import type { RuntimeIngressRequest } from "@firegrid/protocol/runtime-ingress"
import {
  SandboxProvider,
  type SandboxCommand,
  type SandboxProviderService,
} from "@firegrid/runtime/sources/sandbox"
import { Clock, type Context, Duration, Effect, Layer, Option, Schema, Stream } from "effect"
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
  RuntimeContextWorkflowRuntime,
} from "./runtime-context-workflow-runtime.ts"
import { executeRuntimeContextWorkflow } from "./internal/run-context-workflow.ts"
import {
  RuntimeContextWorkflowNative,
  RuntimeContextWorkflowPayload,
} from "./runtime-context-workflow-core.ts"
import {
  runtimeContextWorkflowSupportLayer,
} from "./runtime-context-workflow-support.ts"
import type { RuntimeAgentOutputObservation } from "@firegrid/runtime/runtime-output"
import { SessionAgentOutputChannel } from "@firegrid/protocol/channels"
import type {
  ApprovalCallPermissionRequest,
  ApprovalCallRequest,
} from "@firegrid/protocol/agent-tools"
import type { RuntimeContextMcpChannelCatalog } from "./channel.ts"

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
  )).pipe(
    Effect.withSpan("firegrid.host.agent_tool.unsupported", {
      kind: "internal",
      attributes: {
        "firegrid.agent_tool.name": name,
        "firegrid.agent_tool.tool_use_id": toolUseId,
      },
    }),
  )

// firegrid-schema-projection-contract — the `execute` agent tool input is
// sandbox-neutral `Schema.Unknown` at the protocol boundary; shaping it
// into a concrete `SandboxCommand` is a host-execution concern (see
// tool-host.ts docstring). This is the host-side command contract: a
// non-empty argv plus optional cwd/env/stdin. Decode failures surface as
// an actionable ToolExecutionFailed, never a defect.
const ExecuteCommandInputSchema = Schema.Struct({
  argv: Schema.NonEmptyArray(Schema.String),
  cwd: Schema.optional(Schema.String),
  envVars: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
  stdin: Schema.optional(Schema.String),
})

const sandboxCommandFromInput = (
  toolUseId: string,
  input: unknown,
): Effect.Effect<SandboxCommand, ReturnType<typeof toolExecutionFailed>> =>
  Schema.decodeUnknown(ExecuteCommandInputSchema)(input).pipe(
    Effect.map((decoded): SandboxCommand => ({
      argv: decoded.argv,
      ...(decoded.cwd === undefined ? {} : { cwd: decoded.cwd }),
      ...(decoded.envVars === undefined ? {} : { envVars: decoded.envVars }),
      ...(decoded.stdin === undefined ? {} : { stdin: decoded.stdin }),
    })),
    Effect.mapError(cause =>
      toolExecutionFailed(
        toolUseId,
        "execute",
        new Error(
          "execute input must be { argv: non-empty string[], cwd?, envVars?, stdin? }",
          { cause },
        ),
      )),
  )

// firegrid-schema-projection-contract — provider side-effect execution.
// `SandboxProvider` is reached as an OPTIONAL build-time capability
// (mirrors Gap-1 `CallerOwnedFactStreams`): it is composed in the host
// `namespaceScopedLayer` and is in scope where `RuntimeHostAgentToolHostLive`
// is built, but it is intentionally NOT added to the narrow
// `HostRuntimeContextExecutionEnv` deferred-capture type (TFIND-031). The
// agent surface stays the sandbox-neutral `execute` tool only — no client
// method, no widening of the protected deferred-capture boundary.
const runProviderExecute = (
  sandboxProvider: Option.Option<SandboxProviderService>,
  args: {
    readonly toolUseId: string
    readonly labels: Record<string, string>
    readonly workingDir?: string
    readonly input: unknown
  },
): Effect.Effect<unknown, ReturnType<typeof toolExecutionFailed>> =>
  Option.match(sandboxProvider, {
    onNone: () =>
      Effect.fail(toolExecutionFailed(
        args.toolUseId,
        "execute",
        new Error(
          "execute requires a SandboxProvider in the host composition; none is provided",
        ),
      )),
    onSome: provider =>
      Effect.gen(function*() {
        const command = yield* sandboxCommandFromInput(args.toolUseId, args.input)
        const sandbox = yield* provider.getOrCreate({
          labels: args.labels,
          ...(args.workingDir === undefined
            ? {}
            : { workingDir: args.workingDir }),
        }).pipe(
          Effect.mapError(cause =>
            toolExecutionFailed(args.toolUseId, "execute", cause)),
        )
        return yield* provider.execute(sandbox, command).pipe(
          Effect.mapError(cause =>
            toolExecutionFailed(args.toolUseId, "execute", cause)),
        )
      }),
  }).pipe(
    Effect.withSpan("firegrid.host.agent_tool.execute", {
      kind: "internal",
      attributes: {
        "firegrid.agent_tool.tool_use_id": args.toolUseId,
      },
    }),
  )

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
  // tf-p7w Gap-3: host durable-streams coordinates so the lifecycle
  // control-request is written through the SAME client-equivalent
  // durable RuntimeControlPlaneTable backing the reconciler reads.
  readonly durableStreamsBaseUrl: string
  readonly namespace: string
  readonly workflowRuntime: RuntimeContextWorkflowRuntime["Type"]
  readonly agentToolHost: AgentToolHostService
  readonly sessionAgentOutput: SessionAgentOutputChannel["Type"]
  // TFIND-031: ambient host durable substrate captured at layer-build
  // time, re-provided into the deferred child-context workflow run.
  readonly hostContext: Context.Context<HostRuntimeContextExecutionEnv | RuntimeContextMcpChannelCatalog>
  // Gap-2: optional provider side-effect capability resolved at
  // layer-build time. NOT part of `hostContext` — never re-provided into
  // the deferred child-context workflow capture (TFIND-031 boundary held).
  readonly sandboxProvider: Option.Option<SandboxProviderService>
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
      // TFIND-031: discharge the host runtime context the deferred
      // child-context workflow genuinely needs. Always satisfied at
      // runtime by the composed host layer; `any` previously hid the
      // requirement.
      Effect.provide(captured.hostContext),
      Effect.mapError(cause => toolExecutionFailed(toolUseId, "session_new", cause)),
      Effect.withSpan("firegrid.host.agent_tool.session_new", {
        kind: "internal",
        attributes: {
          "firegrid.context.parent_id": parentContextId,
          "firegrid.agent_tool.tool_use_id": toolUseId,
          "firegrid.agent.kind": agentKind,
        },
      }),
    ),
  spawnChildContexts: ({ toolUseId }) => unsupportedAgentTool(toolUseId, "spawn_all"),
  executeSandboxTool: ({ toolUseId, sandbox, input }) =>
    runProviderExecute(captured.sandboxProvider, {
      toolUseId,
      labels: {
        firegridSandboxProvider: sandbox.providerName,
        firegridSandboxTool: sandbox.toolName,
      },
      input,
    }),
  executeSessionCapability: ({ toolUseId, sessionId, capability, input }) =>
    requireLocalContextWithHostCapabilities(captured, sessionId).pipe(
      Effect.mapError(cause =>
        toolExecutionFailed(toolUseId, "execute", cause)),
      Effect.flatMap(context =>
        runProviderExecute(captured.sandboxProvider, {
          toolUseId,
          labels: {
            firegridRuntimeContextId: context.contextId,
            firegridSessionCapabilityKind: capability.kind,
            firegridSessionCapabilityName: capability.name,
          },
          ...(context.runtime.config.cwd === undefined
            ? {}
            : { workingDir: context.runtime.config.cwd }),
          input,
        })),
    ),
  callApprovalChannel: ({ toolUseId, contextId, channel, request }) => {
    if (!channel.startsWith("approval.")) {
      return Effect.fail(
        toolExecutionFailed(
          toolUseId,
          "call",
          `unsupported approval channel target: ${channel}`,
        ),
      ).pipe(
        Effect.withSpan("firegrid.host.agent_tool.call.approval", {
          kind: "internal",
          attributes: {
            "firegrid.context.id": contextId,
            "firegrid.agent_tool.tool_use_id": toolUseId,
          },
        }),
      )
    }

    return Effect.gen(function*() {
      yield* requireLocalContextWithHostCapabilities(captured, contextId)
      const matched = yield* waitForApprovalPermissionRequest(
        captured.sessionAgentOutput,
        contextId,
        request,
      )
      if (Option.isNone(matched)) {
        return { matched: false, timedOut: true } as const
      }
      const permission = matched.value
      const idempotencyKey = request.idempotencyKey ??
        `permission-response:${contextId}:${permission.permissionRequestId}`
      const row = yield* appendIngressWithHostCapabilities(captured, {
        contextId,
        kind: "required_action_result",
        authoredBy: "client",
        payload: {
          _tag: "PermissionResponse",
          permissionRequestId: permission.permissionRequestId,
          decision: request.decision,
        },
        idempotencyKey,
      })
      return {
        matched: true,
        request: permission,
        response: {
          responded: true,
          contextId,
          permissionRequestId: permission.permissionRequestId,
          inputId: row.inputId,
        },
      } as const
    }).pipe(
      Effect.mapError(cause => toolExecutionFailed(toolUseId, "call", cause)),
      Effect.withSpan("firegrid.host.agent_tool.call.approval", {
        kind: "internal",
        attributes: {
          "firegrid.context.id": contextId,
          "firegrid.agent_tool.tool_use_id": toolUseId,
        },
      }),
    )
  },
  appendSessionPrompt: ({ toolUseId, sessionId, inputId, prompt }) =>
    // firegrid-factory-aligned-agent-tools.PROMPT_DISPATCH.2
    appendIngressWithHostCapabilities(captured, {
      contextId: sessionId,
      inputId,
      kind: "message",
      authoredBy: "workflow",
      payload: prompt,
      idempotencyKey: inputId,
    }).pipe(
      Effect.asVoid,
      Effect.mapError(cause =>
        toolExecutionFailed(toolUseId, "session_prompt", cause)),
      Effect.withSpan("firegrid.host.agent_tool.session_prompt", {
        kind: "internal",
        attributes: {
          "firegrid.context.id": sessionId,
          "firegrid.input.id": inputId,
          "firegrid.agent_tool.tool_use_id": toolUseId,
        },
      }),
    ),
  // tf-p7w Gap-3 (Option A): write the durable session-lifecycle
  // terminate request through a committed RuntimeControlPlaneTable bound
  // to the exact control-plane stream URL the reconciler reads. Later
  // tf-p7w source verification exonerated DurableTable materialization;
  // this append-site still carries the required "outside the tool-use
  // activity commit" property, while the reconciler owns starvation-free
  // lifecycle consumption.
  cancelSession: ({ toolUseId, sessionId }) =>
    appendCommittedLifecycleRequest(captured, {
      contextId: sessionId,
      lifecycle: "cancel",
    }).pipe(
      Effect.mapError(cause =>
        toolExecutionFailed(toolUseId, "session_cancel", cause)),
      Effect.withSpan("firegrid.host.agent_tool.session_cancel", {
        kind: "internal",
        attributes: {
          "firegrid.context.id": sessionId,
          "firegrid.agent_tool.tool_use_id": toolUseId,
        },
      }),
    ),
  closeSession: ({ toolUseId, sessionId }) =>
    appendCommittedLifecycleRequest(captured, {
      contextId: sessionId,
      lifecycle: "close",
    }).pipe(
      Effect.mapError(cause =>
        toolExecutionFailed(toolUseId, "session_close", cause)),
      Effect.withSpan("firegrid.host.agent_tool.session_close", {
        kind: "internal",
        attributes: {
          "firegrid.context.id": sessionId,
          "firegrid.agent_tool.tool_use_id": toolUseId,
        },
      }),
    ),
})

const permissionRequestFromObservation = (
  observation: RuntimeAgentOutputObservation,
): Option.Option<ApprovalCallPermissionRequest> => {
  if (observation._tag !== "PermissionRequest") return Option.none()
  const event = observation.event
  if (event._tag !== "PermissionRequest") return Option.none()
  return Option.some({
    contextId: observation.contextId,
    activityAttempt: observation.activityAttempt,
    sequence: observation.sequence,
    permissionRequestId: event.permissionRequestId,
    toolUseId: event.toolUseId,
    options: event.options,
  })
}

const waitForApprovalPermissionRequest = (
  sessionAgentOutput: SessionAgentOutputChannel["Type"],
  contextId: string,
  request: ApprovalCallRequest,
): Effect.Effect<Option.Option<ApprovalCallPermissionRequest>, unknown> => {
  const wait = sessionAgentOutput.forContext(contextId).binding.stream.pipe(
    Stream.filter(observation =>
      request.afterSequence === undefined ||
      observation.sequence > request.afterSequence,
    ),
    Stream.filterMap(permissionRequestFromObservation),
    Stream.runHead,
  )
  return request.timeoutMs === undefined
    ? wait
    : Effect.raceFirst(
      wait,
      Clock.sleep(Duration.millis(request.timeoutMs)).pipe(
        Effect.as(Option.none<ApprovalCallPermissionRequest>()),
      ),
    )
}

// Client-equivalent committed control-plane write. The client appends
// context/start requests through a `RuntimeControlPlaneTable` bound to
// `runtimeControlPlaneStreamUrl({baseUrl, namespace})` — the exact
// durable-streams stream the host control-request reconciler polls.
// This keeps session lifecycle requests on the same committed public
// control-plane path rather than relying on the enclosing tool-use
// activity to commit before the clean-unwind request becomes visible.
const appendCommittedLifecycleRequest = (
  captured: {
    readonly durableStreamsBaseUrl: string
    readonly namespace: string
  },
  request: {
    readonly contextId: string
    readonly lifecycle: "cancel" | "close"
  },
): Effect.Effect<void, unknown> =>
  Effect.scoped(
    Effect.gen(function*() {
      const row = makeRuntimeLifecycleRequestRow({
        contextId: request.contextId,
        lifecycle: request.lifecycle,
        requestedBy: "agent-tool",
      })
      const table = yield* RuntimeControlPlaneTable
      yield* table.lifecycleRequests.insertOrGet(row).pipe(Effect.asVoid)
    }).pipe(
      Effect.provide(
        RuntimeControlPlaneTable.layer({
          streamOptions: {
            url: runtimeControlPlaneStreamUrl({
              baseUrl: captured.durableStreamsBaseUrl,
              namespace: captured.namespace,
            }),
            contentType: "application/json",
          },
        }),
      ),
    ),
  )

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
  },
  request: RuntimeIngressRequest,
) =>
  appendRuntimeIngress(request).pipe(
    Effect.provideService(RuntimeContextRead, captured.contextRead),
    Effect.provideService(RuntimeControlPlaneTable, captured.controlTable),
  )

const startChildContextWorkflow = (
  captured: {
    readonly contextRead: RuntimeContextReadService
    readonly hostSession: HostSessionRow
    readonly workflowRuntime: RuntimeContextWorkflowRuntime["Type"]
    readonly agentToolHost: AgentToolHostService
  },
  contextId: string,
) =>
  Effect.gen(function*() {
    const context = yield* requireLocalContextWithHostCapabilities(captured, contextId)
    yield* captured.workflowRuntime.run({
      context,
      workflowName: RuntimeContextWorkflowNative.name,
      supportLayer: runtimeContextWorkflowSupportLayer(contextId, captured.agentToolHost),
      effect: Effect.gen(function* () {
        const engine = yield* WorkflowEngine.WorkflowEngine
        yield* executeRuntimeContextWorkflow(
          engine,
          RuntimeContextWorkflowNative,
          {
            executionId: runtimeContextWorkflowExecutionId(contextId),
            payload: RuntimeContextWorkflowPayload.make({ contextId }),
            discard: true,
          },
        )
      }).pipe(
        Effect.withClock(runtimeExecutionClock),
      ),
    })
  })

export const RuntimeHostAgentToolHostLive = Layer.effect(
  AgentToolHost,
  Effect.gen(function* () {
    const contextInsert = yield* RuntimeContextInsert
    const contextRead = yield* RuntimeContextRead
    const hostSession = yield* CurrentHostSession
    const controlTable = yield* RuntimeControlPlaneTable
    const hostConfig = yield* RuntimeHostConfig
    const workflowRuntime = yield* RuntimeContextWorkflowRuntime
    const sessionAgentOutput = yield* SessionAgentOutputChannel
    // TFIND-031: capture the ambient host durable substrate so the
    // deferred child-context workflow (run later, outside this gen) can
    // re-provide it. Always present here via the composed host layer.
    const hostContext = yield* Effect.context<
      HostRuntimeContextExecutionEnv | RuntimeContextMcpChannelCatalog
    >()
    // Gap-2: optional provider side-effect capability. Resolved at
    // layer-build time, NOT folded into `hostContext` — the TFIND-031
    // deferred-capture boundary stays narrow.
    const sandboxProvider = yield* Effect.serviceOption(SandboxProvider)
    const service: AgentToolHostService = runtimeHostAgentToolHostService({
      contextInsert,
      contextRead,
      hostSession,
      controlTable,
      durableStreamsBaseUrl: hostConfig.durableStreamsBaseUrl,
      namespace: hostConfig.namespace,
      workflowRuntime,
      sessionAgentOutput,
      hostContext,
      sandboxProvider,
      get agentToolHost() {
        return service
      },
    })
    return service
  }),
).pipe(Layer.annotateSpans("firegrid.side", "agent-tools"))
