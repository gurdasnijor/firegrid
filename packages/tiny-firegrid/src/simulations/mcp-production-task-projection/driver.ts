/**
 * mcp-production-task-projection driver — drives the production task-projection
 * path PURELY over `@firegrid/client-sdk/mcp` (tf-ll90.8.4). No firegrid.ts
 * client: the host owns the gateway RuntimeContext (see ./host.ts) carrying the
 * claude-acp agent; the driver waits for that gateway context over MCP, then
 * provisions one child via `session_new` (= mcp.sessions.createOrLoad), prompts
 * it as an MCP Task (session.promptTask), follows the task lifecycle
 * (session.taskStates) answering the input_required permission gate
 * (session.respondToPermission), and reads the terminal result
 * (session.taskResult). Creds-gated on ANTHROPIC_API_KEY (claude-acp).
 *
 * Airgapped imports: `@firegrid/client-sdk/mcp`, `@firegrid/client-sdk/config`,
 * and `effect` only. `FiregridConfig` is the sole config Tag (R = FiregridConfig).
 */

import { FiregridConfig } from "@firegrid/client-sdk/config"
import { makeFiregridMcpClient } from "@firegrid/client-sdk/mcp"
import { Config, Duration, Effect, Option, Stream } from "effect"

// Airgapped driver — MIRRORS ./host.ts literals (kept in sync).
const gatewayContextId =
  "session:tiny-firegrid:mcp-production-task-projection-gateway"
const streamId = "mcp-production-task-projection"
const marker = "MCP_PRODUCTION_TASK_PROJECTION_DONE"

const anthropicKeyConfig = Config.redacted("ANTHROPIC_API_KEY").pipe(
  Config.option,
)

const claudeAcpArgv = [
  "npx",
  "-y",
  "@agentclientprotocol/claude-agent-acp@0.36.1",
] as const

const terminalStatuses = new Set(["completed", "failed", "cancelled"])

interface ScenarioResult {
  readonly sessionPromptTaskId: string
  readonly childSessionId: string
  readonly taskStatuses: string
  readonly sawInputRequired: boolean
  readonly sentTaskUpdate: boolean
  readonly resultHadMarker: boolean
  readonly permissionRoundtripCompleted: boolean
}

export const mcpProductionTaskProjectionDriver: Effect.Effect<void, unknown, FiregridConfig> =
  Effect.scoped(Effect.gen(function*() {
    const anthropicKey = yield* anthropicKeyConfig
    if (Option.isNone(anthropicKey)) {
      yield* Effect.annotateCurrentSpan({
        "firegrid.mcp_production_tasks.status": "blocked",
        "firegrid.mcp_production_tasks.blocked_reason": "ANTHROPIC_API_KEY is absent",
        "firegrid.mcp_production_tasks.anthropic_api_key_present": false,
      })
      return
    }

    const config = yield* FiregridConfig
    if (config.durableStreamsBaseUrl === undefined || config.namespace === undefined) {
      return yield* Effect.fail(
        new Error("mcp production task projection requires durableStreamsBaseUrl and namespace"),
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
    const permissionProbePath =
      `packages/tiny-firegrid/.simulate/mcp-production-task-projection-${globalThis.crypto.randomUUID()}.txt`
    const promptText = [
      "Use your available local tooling to create or update this file:",
      permissionProbePath,
      "",
      "The file contents must be exactly:",
      marker,
      "",
      "If the environment asks for permission, request it and wait.",
      `After the file operation succeeds, reply with exactly: ${marker}`,
    ].join("\n")

    const session = yield* mcp.sessions.createOrLoad({
      agentKind: "claude-acp",
      prompt: "Stand by for a task-projection probe.",
    })

    // Prompt the child as an MCP Task and follow its lifecycle, answering the
    // input_required permission gate via respondToPermission.
    const promptTask = yield* session.promptTask({
      prompt: promptText,
      inputId: "tiny-firegrid-mcp-production-task-projection-prompt-1",
      taskTtlMs: 120_000,
    })

    const statuses: Array<string> = []
    let sentTaskUpdate = false
    let permissionTaskId: string | undefined
    const terminal = yield* session.taskStates(promptTask.taskId).pipe(
      Stream.tap(task =>
        Effect.gen(function*() {
          statuses.push(task.status)
          if (task.status === "input_required" && !sentTaskUpdate) {
            sentTaskUpdate = true
            permissionTaskId = task.taskId
            yield* session.respondToPermission(task.taskId, { _tag: "Allow" })
          }
        })),
      Stream.filter(task => terminalStatuses.has(task.status)),
      Stream.runHead,
      Effect.timeoutFail({
        duration: Duration.minutes(5),
        onTimeout: () => new Error("prompt task did not reach terminal status"),
      }),
      Effect.flatMap(Option.match({
        onNone: () => Effect.fail(new Error("prompt task produced no terminal status")),
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
      childSessionId: session.sessionId,
      taskStatuses: statuses.join(","),
      sawInputRequired: statuses.includes("input_required"),
      sentTaskUpdate,
      resultHadMarker: promptContent.includes(marker),
      permissionRoundtripCompleted:
        promptStructured.permissionRoundtripCompleted === true,
    }

    // Read a snapshot of the child context over MCP for observation parity.
    const snapshot = yield* Effect.option(mcp.observations.snapshot(session.contextId))
    const snapshotRunCount = Option.match(snapshot, {
      onNone: () => 0,
      onSome: value => value.runs.length,
    })

    yield* Effect.annotateCurrentSpan({
      "firegrid.mcp_production_tasks.status": terminal.status === "completed"
        ? "completed"
        : terminal.status,
      "firegrid.mcp_production_tasks.anthropic_api_key_present": true,
      "firegrid.mcp_production_tasks.gateway_context_id": gatewayContextId,
      "firegrid.mcp_production_tasks.session_prompt_task_id": result.sessionPromptTaskId,
      "firegrid.mcp_production_tasks.child_session_id": result.childSessionId,
      "firegrid.mcp_production_tasks.child_context_id": session.contextId,
      "firegrid.mcp_production_tasks.permission_task_id": permissionTaskId ?? "",
      "firegrid.mcp_production_tasks.task_statuses": result.taskStatuses,
      "firegrid.mcp_production_tasks.saw_input_required": result.sawInputRequired,
      "firegrid.mcp_production_tasks.sent_task_update": result.sentTaskUpdate,
      "firegrid.mcp_production_tasks.result_had_marker": result.resultHadMarker,
      "firegrid.mcp_production_tasks.permission_roundtrip_completed": result.permissionRoundtripCompleted,
      "firegrid.mcp_production_tasks.snapshot_run_count": snapshotRunCount,
      "firegrid.mcp_production_tasks.transport": "mcp",
      "firegrid.mcp_production_tasks.spawn_target": claudeAcpArgv.join(" "),
    })
  })).pipe(
    Effect.withSpan("tiny_firegrid.mcp_production_task_projection.driver", {
      kind: "client",
    }),
  )
