import { FiregridConfig } from "@firegrid/client-sdk/config"
import {
  makeFiregridMcpClient,
  type FiregridMcpTask,
} from "@firegrid/client-sdk/mcp"
import { Config, Duration, Effect, Fiber, Option, Stream } from "effect"

const claudeAcpArgv = [
  "npx",
  "-y",
  "@agentclientprotocol/claude-agent-acp@0.36.1",
] as const

const anthropicKeyConfig = Config.redacted("ANTHROPIC_API_KEY").pipe(
  Config.option,
)

const gatewayContextId =
  "session:tiny-firegrid:mcp-client-sdk-observations-gateway"
const streamId = "mcp-client-sdk-observations"
const marker = "MCP_CLIENT_SDK_OBSERVATIONS_DONE"

interface WatchedTask {
  readonly statuses: ReadonlyArray<string>
  readonly sentUpdate: boolean
  readonly terminal: FiregridMcpTask | undefined
}

interface ScenarioResult {
  readonly resourcesListed: number
  readonly contextsListed: number
  readonly watchObservedChild: boolean
  readonly snapshotContextId: string
  readonly snapshotAgentOutputCount: number
  readonly initialOutputMatched: boolean
  readonly permissionWaitMatched: boolean
  readonly taskStatuses: string
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

const resourceCount = (value: unknown): number => {
  const record = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {}
  return Array.isArray(record.resources) ? record.resources.length : 0
}

const requireSome = <A>(
  value: Option.Option<A>,
  message: string,
): Effect.Effect<A, Error> =>
  Option.match(value, {
    onNone: () => Effect.fail(new Error(message)),
    onSome: Effect.succeed,
  })

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
      onTimeout: () => new Error("client-sdk MCP observation prompt task did not reach terminal status"),
    }),
  )

export const mcpClientSdkObservationsDriver: Effect.Effect<void, unknown, FiregridConfig> =
  Effect.scoped(Effect.gen(function*() {
    const anthropicKey = yield* anthropicKeyConfig
    if (Option.isNone(anthropicKey)) {
      yield* Effect.annotateCurrentSpan({
        "firegrid.mcp_client_sdk_observations.status": "blocked",
        "firegrid.mcp_client_sdk_observations.blocked_reason": "ANTHROPIC_API_KEY is absent",
        "firegrid.mcp_client_sdk_observations.anthropic_api_key_present": false,
      })
      return
    }

    const config = yield* FiregridConfig
    if (config.durableStreamsBaseUrl === undefined || config.namespace === undefined) {
      return yield* Effect.fail(new Error("mcp client-sdk observations requires durableStreamsBaseUrl and namespace"))
    }

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
      prompt: "Stand by for the next Firegrid task. Reply with exactly: MCP_CLIENT_SDK_OBSERVATIONS_READY",
    })

    const resourcesListed = resourceCount(yield* mcp.observations.resourcesList)
    const contexts = yield* mcp.observations.listContexts
    const watchedChild = yield* mcp.observations.watchContexts(
      context => context.contextId === child.contextId,
    ).pipe(
      Stream.runHead,
      Effect.timeoutFail({
        duration: Duration.seconds(30),
        onTimeout: () => new Error("MCP observation watch did not see the child context"),
      }),
      Effect.flatMap(option => requireSome(option, "MCP observation watch returned no child context")),
    )
    const initialOutput = yield* child.wait.forAgentOutput({ timeoutMs: 60_000 })
    const initialSequence = initialOutput.matched
      ? initialOutput.output.sequence
      : undefined
    const initialSnapshot = yield* child.snapshot()

    const sessionPromptTask = yield* child.promptTask({
      prompt: promptText(
        `packages/tiny-firegrid/.simulate/mcp-client-sdk-observations-${globalThis.crypto.randomUUID()}.txt`,
      ),
      inputId: "tiny-firegrid-mcp-client-sdk-observations-prompt-1",
    })
    const permissionWaitFiber = yield* child.wait.forPermissionRequest({
      ...(initialSequence === undefined ? {} : { afterSequence: initialSequence }),
      timeoutMs: 240_000,
    }).pipe(Effect.fork)
    const watched = yield* watchPromptTask(
      sessionPromptTask,
      child.taskStates(sessionPromptTask.taskId),
      taskId => child.respondToPermission(taskId, { _tag: "Allow" }),
    )
    const permissionWait = yield* Fiber.join(permissionWaitFiber)
    const promptResult = yield* child.taskResult(sessionPromptTask.taskId)
    const promptRecord = typeof promptResult === "object" && promptResult !== null
      ? promptResult as Record<string, unknown>
      : {}
    const promptContent = JSON.stringify(promptRecord)
    const promptStructured = typeof promptRecord.structuredContent === "object" &&
        promptRecord.structuredContent !== null
      ? promptRecord.structuredContent as Record<string, unknown>
      : {}
    const finalSnapshot = yield* child.snapshot()

    const result: ScenarioResult = {
      resourcesListed,
      contextsListed: contexts.length,
      watchObservedChild: watchedChild.contextId === child.contextId,
      snapshotContextId: initialSnapshot.contextId,
      snapshotAgentOutputCount: finalSnapshot.agentOutputs.length,
      initialOutputMatched: initialOutput.matched,
      permissionWaitMatched: permissionWait.matched,
      taskStatuses: watched.statuses.join(","),
      sentTaskUpdate: watched.sentUpdate,
      resultHadMarker: promptContent.includes(marker),
      permissionRoundtripCompleted:
        promptStructured.permissionRoundtripCompleted === true,
    }

    yield* Effect.annotateCurrentSpan({
      "firegrid.mcp_client_sdk_observations.status": "completed",
      "firegrid.mcp_client_sdk_observations.anthropic_api_key_present": true,
      "firegrid.mcp_client_sdk_observations.gateway_context_id": gatewayContextId,
      "firegrid.mcp_client_sdk_observations.child_session_id": child.sessionId,
      "firegrid.mcp_client_sdk_observations.child_context_id": child.contextId,
      "firegrid.mcp_client_sdk_observations.resources_listed": result.resourcesListed,
      "firegrid.mcp_client_sdk_observations.contexts_listed": result.contextsListed,
      "firegrid.mcp_client_sdk_observations.watch_observed_child": result.watchObservedChild,
      "firegrid.mcp_client_sdk_observations.snapshot_context_id": result.snapshotContextId,
      "firegrid.mcp_client_sdk_observations.snapshot_agent_output_count": result.snapshotAgentOutputCount,
      "firegrid.mcp_client_sdk_observations.initial_output_matched": result.initialOutputMatched,
      "firegrid.mcp_client_sdk_observations.permission_wait_matched": result.permissionWaitMatched,
      "firegrid.mcp_client_sdk_observations.task_statuses": result.taskStatuses,
      "firegrid.mcp_client_sdk_observations.sent_task_update": result.sentTaskUpdate,
      "firegrid.mcp_client_sdk_observations.result_had_marker": result.resultHadMarker,
      "firegrid.mcp_client_sdk_observations.permission_roundtrip_completed": result.permissionRoundtripCompleted,
      "firegrid.mcp_client_sdk_observations.spawn_target": claudeAcpArgv.join(" "),
    })
  })).pipe(
    Effect.withSpan("tiny_firegrid.mcp_client_sdk_observations.driver", {
      kind: "client",
    }),
  )
