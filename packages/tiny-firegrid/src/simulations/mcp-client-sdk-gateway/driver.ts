import {
  Firegrid,
  FiregridConfig,
  local,
} from "@firegrid/client-sdk/firegrid"
import {
  makeFiregridMcpClient,
  type FiregridMcpTask,
} from "@firegrid/client-sdk/mcp"
import { Config, Duration, Effect, Option, Stream } from "effect"

const claudeAcpArgv = [
  "npx",
  "-y",
  "@agentclientprotocol/claude-agent-acp@0.36.1",
] as const

const anthropicKeyConfig = Config.redacted("ANTHROPIC_API_KEY").pipe(
  Config.option,
)

const gatewayExternalKey = {
  source: "tiny-firegrid",
  id: "mcp-production-task-projection-parent",
} as const

const gatewayContextId = `session:${gatewayExternalKey.source}:${gatewayExternalKey.id}`
const streamId = "mcp-production-task-projection"
const marker = "MCP_CLIENT_SDK_GATEWAY_DONE"

interface WatchedTask {
  readonly statuses: ReadonlyArray<string>
  readonly sentUpdate: boolean
  readonly terminal: FiregridMcpTask | undefined
}

interface ScenarioResult {
  readonly sessionPromptTaskId: string
  readonly childSessionId: string
  readonly childContextId: string
  readonly taskStatuses: string
  readonly sawInputRequired: boolean
  readonly sentTaskUpdate: boolean
  readonly resultHadMarker: boolean
  readonly permissionRoundtripCompleted: boolean
}

const terminalStatuses = new Set(["completed", "failed", "cancelled"])

const promptText = (permissionProbePath: string) =>
  [
    "Use your available local tooling to create or update this file:",
    permissionProbePath,
    "",
    "The file contents must be exactly:",
    marker,
    "",
    "If the environment asks for permission, request it and wait.",
    `After the file operation succeeds, reply with exactly: ${marker}`,
  ].join("\n")

const watchPromptTask = (
  task: FiregridMcpTask,
  states: Stream.Stream<FiregridMcpTask, unknown>,
  respondToPermission: (
    taskId: string,
  ) => Effect.Effect<unknown, unknown>,
): Effect.Effect<WatchedTask, unknown> =>
  states.pipe(
    Stream.runFoldWhileEffect(
      {
        statuses: [] as Array<string>,
        sentUpdate: false,
        terminal: undefined as FiregridMcpTask | undefined,
      },
      state => state.terminal === undefined,
      (state, current) =>
        Effect.gen(function*() {
          const statuses = [...state.statuses, current.status]
          const shouldUpdate =
            current.status === "input_required" && !state.sentUpdate
          if (shouldUpdate) {
            yield* respondToPermission(task.taskId)
          }
          return {
            statuses,
            sentUpdate: state.sentUpdate || shouldUpdate,
            terminal: terminalStatuses.has(current.status)
              ? current
              : undefined,
          }
        }),
    ),
    Effect.timeoutFail({
      duration: Duration.minutes(5),
      onTimeout: () => new Error("client-sdk MCP prompt task did not reach terminal status"),
    }),
  )

export const mcpClientSdkGatewayDriver: Effect.Effect<void, unknown, Firegrid | FiregridConfig> =
  Effect.scoped(Effect.gen(function*() {
    const anthropicKey = yield* anthropicKeyConfig
    if (Option.isNone(anthropicKey)) {
      yield* Effect.annotateCurrentSpan({
        "firegrid.mcp_client_sdk.status": "blocked",
        "firegrid.mcp_client_sdk.blocked_reason": "ANTHROPIC_API_KEY is absent",
        "firegrid.mcp_client_sdk.anthropic_api_key_present": false,
      })
      return
    }

    const firegrid = yield* Firegrid
    const config = yield* FiregridConfig
    if (config.durableStreamsBaseUrl === undefined || config.namespace === undefined) {
      return yield* Effect.fail(new Error("mcp client-sdk gateway requires durableStreamsBaseUrl and namespace"))
    }

    yield* firegrid.sessions.createOrLoad({
      externalKey: gatewayExternalKey,
      runtime: local.jsonl({
        argv: [...claudeAcpArgv],
        agent: "claude-acp",
        agentProtocol: "acp",
        cwd: globalThis.process.cwd(),
        envBindings: [
          { name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" },
        ],
      }),
      createdBy: "tiny-firegrid-simulation",
    })

    const mcp = yield* makeFiregridMcpClient({
      durableStreamsBaseUrl: config.durableStreamsBaseUrl,
      namespace: config.namespace,
      streamId,
      clientId: 2,
      pollIntervalMs: 500,
    })

    yield* mcp.initialize
    yield* mcp.toolsList

    const child = yield* mcp.sessions.createOrLoad({
      agentKind: "claude-acp",
      prompt: "Stand by for the next Firegrid task. Reply with exactly: MCP_CLIENT_SDK_SESSION_READY",
    })

    const sessionPromptTask = yield* child.promptTask({
      prompt: promptText(
        `packages/tiny-firegrid/.simulate/mcp-client-sdk-gateway-${globalThis.crypto.randomUUID()}.txt`,
      ),
      inputId: "tiny-firegrid-mcp-client-sdk-gateway-prompt-1",
    })

    const watched = yield* watchPromptTask(
      sessionPromptTask,
      child.taskStates(sessionPromptTask.taskId),
      taskId => child.respondToPermission(taskId, { _tag: "Allow" }),
    )
    const promptResult = yield* child.taskResult(sessionPromptTask.taskId)
    const promptRecord = typeof promptResult === "object" && promptResult !== null
      ? promptResult as Record<string, unknown>
      : {}
    const promptContent = JSON.stringify(promptRecord)
    const promptStructured = typeof promptRecord.structuredContent === "object" &&
        promptRecord.structuredContent !== null
      ? promptRecord.structuredContent as Record<string, unknown>
      : {}
    const result: ScenarioResult = {
      sessionPromptTaskId: sessionPromptTask.taskId,
      childSessionId: child.sessionId,
      childContextId: child.contextId,
      taskStatuses: watched.statuses.join(","),
      sawInputRequired: watched.statuses.includes("input_required"),
      sentTaskUpdate: watched.sentUpdate,
      resultHadMarker: promptContent.includes(marker),
      permissionRoundtripCompleted:
        promptStructured.permissionRoundtripCompleted === true,
    }

    yield* Effect.annotateCurrentSpan({
      "firegrid.mcp_client_sdk.status": "completed",
      "firegrid.mcp_client_sdk.anthropic_api_key_present": true,
      "firegrid.mcp_client_sdk.gateway_context_id": gatewayContextId,
      "firegrid.mcp_client_sdk.session_prompt_task_id": result.sessionPromptTaskId,
      "firegrid.mcp_client_sdk.child_session_id": result.childSessionId,
      "firegrid.mcp_client_sdk.child_context_id": result.childContextId,
      "firegrid.mcp_client_sdk.task_statuses": result.taskStatuses,
      "firegrid.mcp_client_sdk.saw_input_required": result.sawInputRequired,
      "firegrid.mcp_client_sdk.sent_task_update": result.sentTaskUpdate,
      "firegrid.mcp_client_sdk.result_had_marker": result.resultHadMarker,
      "firegrid.mcp_client_sdk.permission_roundtrip_completed": result.permissionRoundtripCompleted,
      "firegrid.mcp_client_sdk.spawn_target": claudeAcpArgv.join(" "),
    })
  })).pipe(
    Effect.withSpan("tiny_firegrid.mcp_client_sdk_gateway.driver", {
      kind: "client",
    }),
  )
