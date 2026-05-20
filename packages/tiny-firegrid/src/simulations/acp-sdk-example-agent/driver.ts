import {
  Firegrid,
  local,
} from "@firegrid/client-sdk/firegrid"
import { Effect, Option, Stream } from "effect"
import { dirname, join } from "node:path"
import { createRequire } from "node:module"

interface AcpSdkExampleAgentResult {
  readonly sessionId: string
  readonly attachedSessionId: string
  readonly openedSessionContextId: string
  readonly launchContextId: string
  readonly watchedLaunchContextId: string
  readonly launchPromptInputId: string
  readonly preStartRunCount: number
  readonly postTurnRunCount: number
  readonly postTurnOutputCount: number
  readonly scopedPromptInputId: string
  readonly sessionPromptInputId: string
  readonly topLevelPermissionResponseInputId: string
  readonly agentPath: string
  readonly readyTag: string
  readonly firstText: string
  readonly readToolName: string
  readonly readToolStatus: string
  readonly secondText: string
  readonly editToolName: string
  readonly permissionRequestTag: string
  readonly completedEditStatus: string
  readonly finalText: string
  readonly turnCompleteTag: string
  readonly permissionRequestSeen: boolean
}

const require = createRequire(import.meta.url)
const sdkMain = require.resolve("@agentclientprotocol/sdk")
const agentPath = join(dirname(sdkMain), "examples", "agent.js")

export const acpSdkExampleAgentDriver: Effect.Effect<
  AcpSdkExampleAgentResult,
  unknown,
  Firegrid
> = Effect.scoped(Effect.gen(function*() {
  const firegrid = yield* Firegrid
  const launched = yield* firegrid.launch({
    runtime: local.jsonl({
      argv: [
        globalThis.process.execPath,
        "-e",
        "process.exit(0)",
      ],
      agent: "acp-sdk-example-agent-launch-probe",
      agentProtocol: "stdio-jsonl",
      cwd: globalThis.process.cwd(),
    }),
    requestedBy: "tiny-firegrid-simulation",
  })
  const launchedContext = yield* firegrid.watchContexts(
    context => context.contextId === launched.contextId,
  ).pipe(Stream.runHead)
  if (Option.isNone(launchedContext)) {
    return yield* Effect.fail("expected launched context from watchContexts")
  }
  const launchPrompt = yield* firegrid.prompt({
    contextId: launched.contextId,
    payload: "Launch probe prompt through the top-level client prompt API.",
    idempotencyKey: "acp-sdk-example-agent:launch-probe:prompt-1",
  })
  const openedLaunch = firegrid.open(launched.contextId)
  const launchSnapshot = yield* openedLaunch.snapshot
  if (launchSnapshot.context?.contextId !== launched.contextId) {
    return yield* Effect.fail("expected open(...).snapshot() for launched context")
  }

  const session = yield* firegrid.sessions.createOrLoad({
    externalKey: {
      source: "tiny-firegrid",
      id: "acp-sdk-example-agent",
    },
    runtime: local.jsonl({
      argv: ["node", agentPath],
      agent: "acp-sdk-example-agent",
      agentProtocol: "acp",
      cwd: globalThis.process.cwd(),
    }),
    createdBy: "tiny-firegrid-simulation",
  })

  yield* session.whenReady
  const attached = yield* firegrid.sessions.attach({ sessionId: session.sessionId })
  if (attached.contextId !== session.contextId) {
    return yield* Effect.fail("expected attached session context id to match")
  }
  const openedSession = firegrid.open(session.contextId)
  const preStartSnapshot = yield* session.snapshot()
  const openedSessionSnapshot = yield* openedSession.snapshot
  if (openedSessionSnapshot.context?.contextId !== session.contextId) {
    return yield* Effect.fail("expected open(...).snapshot() for session context")
  }
  const watchedSession = yield* firegrid.watchContexts(
    context => context.contextId === session.contextId,
  ).pipe(Stream.runHead)
  if (Option.isNone(watchedSession)) {
    return yield* Effect.fail("expected session context from watchContexts")
  }
  yield* session.permissions.autoApprove("allow")
  const scopedPrompt = yield* session.prompt({
    payload: [
      "Hello from Firegrid tiny-firegrid.",
      "Run the ACP SDK example turn and request permission when needed.",
    ].join(" "),
    idempotencyKey: "acp-sdk-example-agent:turn-1",
  })
  yield* session.start()

  const ready = yield* session.wait.forAgentOutput({ timeoutMs: 10_000 })
  const firstText = yield* session.wait.forAgentOutput({ timeoutMs: 10_000 })
  const readTool = yield* session.wait.forAgentOutput({ timeoutMs: 10_000 })
  const readToolDone = yield* session.wait.forAgentOutput({ timeoutMs: 10_000 })
  const secondText = yield* session.wait.forAgentOutput({ timeoutMs: 10_000 })
  const editTool = yield* session.wait.forAgentOutput({ timeoutMs: 10_000 })
  const permissionRequest = yield* session.wait.forAgentOutput({ timeoutMs: 10_000 })
  if (!permissionRequest.matched) return yield* Effect.fail("expected PermissionRequest")
  if (permissionRequest.output.event._tag !== "PermissionRequest") {
    return yield* Effect.fail("expected PermissionRequest")
  }
  const permissionWait = yield* session.wait.forPermissionRequest({
    afterSequence: permissionRequest.output.sequence - 1,
    timeoutMs: 10_000,
  })
  if (!permissionWait.matched) {
    return yield* Effect.fail("expected scoped permission wait to match")
  }
  const topLevelPermissionResponse = yield* firegrid.permissions.respond({
    contextId: session.contextId,
    permissionRequestId: permissionWait.request.permissionRequestId,
    decision: { _tag: "Allow" },
  })
  const editToolDone = yield* session.wait.forAgentOutput({ timeoutMs: 10_000 })
  const finalText = yield* session.wait.forAgentOutput({ timeoutMs: 10_000 })
  const turnComplete = yield* session.wait.forAgentOutput({ timeoutMs: 10_000 })
  const sessionPrompt = yield* firegrid.sessions.prompt({
    sessionId: session.sessionId,
    prompt: "Post-turn session prompt API coverage.",
    inputId: "acp-sdk-example-agent:session-prompt:post-turn",
  })
  const postTurnSnapshot = yield* attached.snapshot()

  if (!ready.matched) return yield* Effect.fail("expected Ready")
  if (!firstText.matched) return yield* Effect.fail("expected first TextChunk")
  if (!readTool.matched) return yield* Effect.fail("expected read ToolUse")
  if (!readToolDone.matched) return yield* Effect.fail("expected read Status")
  if (!secondText.matched) return yield* Effect.fail("expected second TextChunk")
  if (!editTool.matched) return yield* Effect.fail("expected edit ToolUse")
  if (!editToolDone.matched) return yield* Effect.fail("expected edit Status")
  if (!finalText.matched) return yield* Effect.fail("expected final TextChunk")
  if (!turnComplete.matched) return yield* Effect.fail("expected TurnComplete")
  if (ready.output.event._tag !== "Ready") return yield* Effect.fail("expected Ready")
  if (firstText.output.event._tag !== "TextChunk") return yield* Effect.fail("expected first TextChunk")
  if (readTool.output.event._tag !== "ToolUse") return yield* Effect.fail("expected read ToolUse")
  if (readToolDone.output.event._tag !== "Status") return yield* Effect.fail("expected read Status")
  if (secondText.output.event._tag !== "TextChunk") return yield* Effect.fail("expected second TextChunk")
  if (editTool.output.event._tag !== "ToolUse") return yield* Effect.fail("expected edit ToolUse")
  if (editToolDone.output.event._tag !== "Status") return yield* Effect.fail("expected edit Status")
  if (finalText.output.event._tag !== "TextChunk") return yield* Effect.fail("expected final TextChunk")
  if (turnComplete.output.event._tag !== "TurnComplete") return yield* Effect.fail("expected TurnComplete")
  if (sessionPrompt.appended !== true) return yield* Effect.fail("expected sessions.prompt append")

  const result: AcpSdkExampleAgentResult = {
    sessionId: session.contextId,
    attachedSessionId: attached.sessionId,
    openedSessionContextId: openedSession.contextId,
    launchContextId: launched.contextId,
    watchedLaunchContextId: launchedContext.value.contextId,
    launchPromptInputId: launchPrompt.intentId,
    preStartRunCount: preStartSnapshot.runs.length,
    postTurnRunCount: postTurnSnapshot.runs.length,
    postTurnOutputCount: postTurnSnapshot.agentOutputs.length,
    scopedPromptInputId: scopedPrompt.intentId,
    sessionPromptInputId: sessionPrompt.inputId,
    topLevelPermissionResponseInputId: topLevelPermissionResponse.inputId,
    agentPath,
    readyTag: ready.output.event._tag,
    firstText: firstText.output.event.part.delta,
    readToolName: readTool.output.event.part.name,
    readToolStatus: readToolDone.output.event.kind,
    secondText: secondText.output.event.part.delta,
    editToolName: editTool.output.event.part.name,
    permissionRequestTag: permissionRequest.output.event._tag,
    completedEditStatus: editToolDone.output.event.kind,
    finalText: finalText.output.event.part.delta,
    turnCompleteTag: turnComplete.output.event._tag,
    permissionRequestSeen: true,
  }

  yield* Effect.annotateCurrentSpan({
    "firegrid.acp_sdk_example_agent.session_id": result.sessionId,
    "firegrid.acp_sdk_example_agent.attached_session_id": result.attachedSessionId,
    "firegrid.acp_sdk_example_agent.opened_session_context_id": result.openedSessionContextId,
    "firegrid.acp_sdk_example_agent.launch_context_id": result.launchContextId,
    "firegrid.acp_sdk_example_agent.watched_launch_context_id": result.watchedLaunchContextId,
    "firegrid.acp_sdk_example_agent.launch_prompt_input_id": result.launchPromptInputId,
    "firegrid.acp_sdk_example_agent.pre_start_run_count": result.preStartRunCount,
    "firegrid.acp_sdk_example_agent.post_turn_run_count": result.postTurnRunCount,
    "firegrid.acp_sdk_example_agent.post_turn_output_count": result.postTurnOutputCount,
    "firegrid.acp_sdk_example_agent.scoped_prompt_input_id": result.scopedPromptInputId,
    "firegrid.acp_sdk_example_agent.session_prompt_input_id": result.sessionPromptInputId,
    "firegrid.acp_sdk_example_agent.top_level_permission_response_input_id": result.topLevelPermissionResponseInputId,
    "firegrid.acp_sdk_example_agent.agent_path": result.agentPath,
    "firegrid.acp_sdk_example_agent.ready_tag": result.readyTag,
    "firegrid.acp_sdk_example_agent.read_tool_name": result.readToolName,
    "firegrid.acp_sdk_example_agent.read_tool_status": result.readToolStatus,
    "firegrid.acp_sdk_example_agent.edit_tool_name": result.editToolName,
    "firegrid.acp_sdk_example_agent.permission_request_tag": result.permissionRequestTag,
    "firegrid.acp_sdk_example_agent.completed_edit_status": result.completedEditStatus,
    "firegrid.acp_sdk_example_agent.turn_complete_tag": result.turnCompleteTag,
    "firegrid.acp_sdk_example_agent.permission_request_seen": result.permissionRequestSeen,
  })
  return result
})).pipe(
  Effect.withSpan("firegrid.acp_sdk_example_agent.driver", {
    kind: "client",
  }),
)
