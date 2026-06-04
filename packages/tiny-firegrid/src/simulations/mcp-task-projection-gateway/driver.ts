/**
 * mcp-task-projection-gateway driver — drives the MCP Tasks projection for
 * `session_prompt` PURELY over `@firegrid/client-sdk/mcp` (tf-ll90.8.4). No
 * firegrid.ts client and no sim-local task-projection protocol: the host owns
 * the gateway RuntimeContext (see ./host.ts) carrying the claude-acp agent, and
 * the PRODUCTION MCP ingress now projects the task state from RuntimeContext
 * output (the projection this sim originally hand-wired has been promoted into
 * `runtime/unified/mcp-host/task-projection.ts`).
 *
 * Flow: wait for the host-seeded gateway context over MCP, provision one child
 * via `session_new` (= mcp.sessions.create, inheriting the gateway's
 * claude-acp runtime), prompt it as an MCP Task (session.promptTask), follow the
 * task lifecycle (session.taskStates) answering the input_required permission
 * gate (session.respondToPermission), and read the terminal result
 * (session.taskResult). Creds-gated on ANTHROPIC_API_KEY (claude-acp).
 *
 * Airgapped imports: `@firegrid/client-sdk/mcp`, `@firegrid/client-sdk/config`,
 * and `effect` only. `FiregridConfig` is the sole config Tag (R = FiregridConfig).
 */

import { FiregridConfig } from "@firegrid/client-sdk/config"
import { makeFiregridMcpClient } from "@firegrid/client-sdk/mcp"
import { Config, Duration, Effect, Option, Stream } from "effect"

// Airgapped driver — MIRRORS ./host.ts literals (kept in sync).
const gatewayContextId = "session:tiny-firegrid:mcp-task-projection-gateway-gateway"
const streamId = "mcp-task-projection-gateway"
const marker = "MCP_TASK_PROJECTION_DONE"

const anthropicKeyConfig = Config.redacted("ANTHROPIC_API_KEY").pipe(
  Config.option,
)

const claudeAcpArgv = [
  "npx",
  "-y",
  "@agentclientprotocol/claude-agent-acp@0.36.1",
] as const

const terminalStatuses = new Set(["completed", "failed", "cancelled"])

const promptText = (permissionProbePath: string) => [
  "Use your available local tooling to create or update this file:",
  permissionProbePath,
  "",
  "The file contents must be exactly:",
  marker,
  "",
  "If the environment asks for permission, request it and wait.",
  `After the file operation succeeds, reply with exactly: ${marker}`,
].join("\n")

interface ScenarioResult {
  readonly sessionPromptTaskId: string
  readonly sessionId: string
  readonly taskStatuses: string
  readonly sawInputRequired: boolean
  readonly sentTaskUpdate: boolean
  readonly resultHadMarker: boolean
  readonly permissionRoundtripCompleted: boolean
  readonly projectedFromRuntimeOutput: boolean
  readonly restartRehydrationGetWorked: boolean
}

export const mcpTaskProjectionGatewayDriver: Effect.Effect<void, unknown, FiregridConfig> =
  Effect.scoped(Effect.gen(function*() {
    const anthropicKey = yield* anthropicKeyConfig
    if (Option.isNone(anthropicKey)) {
      yield* Effect.annotateCurrentSpan({
        "firegrid.mcp_task_projection.status": "blocked",
        "firegrid.mcp_task_projection.blocked_reason": "ANTHROPIC_API_KEY is absent",
        "firegrid.mcp_task_projection.anthropic_api_key_present": false,
      })
      return
    }

    const config = yield* FiregridConfig
    if (config.durableStreamsBaseUrl === undefined || config.namespace === undefined) {
      return yield* Effect.fail(
        new Error("mcp task projection requires durableStreamsBaseUrl and namespace"),
      )
    }

    const mcp = yield* makeFiregridMcpClient({
      durableStreamsBaseUrl: config.durableStreamsBaseUrl,
      namespace: config.namespace,
      streamId,
      clientId: 2,
      pollIntervalMs: 250,
    })

    yield* mcp.initialize
    yield* mcp.toolsList

    // Wait for the host-seeded gateway context before provisioning off it.
    yield* mcp.observations.watchContexts(
      context => context.contextId === gatewayContextId,
    ).pipe(
      Stream.runHead,
      Effect.timeoutFail({
        duration: Duration.seconds(30),
        onTimeout: () => new Error("host gateway context did not appear over MCP"),
      }),
    )

    // Provision a child session over MCP — session_new inherits the gateway's
    // claude-acp runtime.
    const session = yield* mcp.sessions.create({
      agentKind: "claude-acp",
      prompt: "Stand by for a task-projection probe.",
    })

    // Prompt the child as an MCP Task; the production ingress projects the task
    // state from the RuntimeContext output emitted after this prompt's cursor.
    const promptTask = yield* session.promptTask({
      prompt: promptText(
        `packages/tiny-firegrid/.simulate/mcp-task-projection-permission-probe-${globalThis.crypto.randomUUID()}.txt`,
      ),
      inputId: "tiny-firegrid-mcp-task-projection-prompt-1",
      taskTtlMs: 120_000,
    })

    const statuses: Array<string> = []
    let sentTaskUpdate = false
    let restartRehydrationGetWorked = false
    const terminal = yield* session.taskStates(promptTask.taskId).pipe(
      Stream.tap(task =>
        Effect.gen(function*() {
          statuses.push(task.status)
          // A `working` status read back from `tasks/get` proves the stateless
          // task id rehydrates against runtime output (no spike-local store).
          restartRehydrationGetWorked = restartRehydrationGetWorked || task.status === "working"
          if (task.status === "input_required" && !sentTaskUpdate) {
            sentTaskUpdate = true
            yield* session.respondToPermission(task.taskId, { _tag: "Allow" })
          }
        })),
      Stream.filter(task => terminalStatuses.has(task.status)),
      Stream.runHead,
      Effect.timeoutFail({
        duration: Duration.minutes(5),
        onTimeout: () => new Error("projected prompt task did not reach terminal status"),
      }),
      Effect.flatMap(Option.match({
        onNone: () => Effect.fail(new Error("projected prompt task produced no terminal status")),
        onSome: Effect.succeed,
      })),
    )

    const promptResult = yield* session.taskResult(promptTask.taskId)
    const promptRecord = typeof promptResult === "object" && promptResult !== null
      ? promptResult as Record<string, unknown>
      : {}
    const promptContent = JSON.stringify(promptRecord)
    const promptStructured = typeof promptRecord.structuredContent === "object" &&
        promptRecord.structuredContent !== null
      ? promptRecord.structuredContent as Record<string, unknown>
      : {}

    const result: ScenarioResult = {
      sessionPromptTaskId: promptTask.taskId,
      sessionId: session.sessionId,
      taskStatuses: statuses.join(","),
      sawInputRequired: statuses.includes("input_required"),
      sentTaskUpdate,
      resultHadMarker: promptContent.includes(marker),
      permissionRoundtripCompleted:
        promptStructured.permissionRoundtripCompleted === true,
      projectedFromRuntimeOutput: promptStructured.projectedFrom === "runtime-output",
      restartRehydrationGetWorked,
    }

    yield* Effect.annotateCurrentSpan({
      "firegrid.mcp_task_projection.status": terminal.status === "completed"
        ? "completed"
        : terminal.status,
      "firegrid.mcp_task_projection.anthropic_api_key_present": true,
      "firegrid.mcp_task_projection.gateway_context_id": gatewayContextId,
      "firegrid.mcp_task_projection.session_prompt_task_id": result.sessionPromptTaskId,
      "firegrid.mcp_task_projection.session_id": result.sessionId,
      "firegrid.mcp_task_projection.child_context_id": session.contextId,
      "firegrid.mcp_task_projection.task_statuses": result.taskStatuses,
      "firegrid.mcp_task_projection.saw_input_required": result.sawInputRequired,
      "firegrid.mcp_task_projection.sent_task_update": result.sentTaskUpdate,
      "firegrid.mcp_task_projection.result_had_marker": result.resultHadMarker,
      "firegrid.mcp_task_projection.permission_roundtrip_completed": result.permissionRoundtripCompleted,
      "firegrid.mcp_task_projection.projected_from_runtime_output": result.projectedFromRuntimeOutput,
      "firegrid.mcp_task_projection.restart_rehydration_get_worked": result.restartRehydrationGetWorked,
      "firegrid.mcp_task_projection.transport": "mcp",
      "firegrid.mcp_task_projection.spawn_target": claudeAcpArgv.join(" "),
    })
  })).pipe(
    Effect.withSpan("tiny_firegrid.mcp_task_projection.driver", {
      kind: "client",
    }),
  )
