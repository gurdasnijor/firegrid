import {
  Firegrid,
  FiregridConfig,
  local,
} from "@firegrid/client-sdk/firegrid"
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
  id: "mcp-tasks-gateway-parent",
} as const

const gatewayContextId = `session:${gatewayExternalKey.source}:${gatewayExternalKey.id}`
const streamId = "mcp-tasks-gateway"

const marker = "MCP_TASKS_GATEWAY_DONE"
const permissionProbePath = "packages/tiny-firegrid/.simulate/mcp-tasks-permission-probe.txt"

const initialPrompt = [
  "This is a Firegrid MCP Tasks simulation bootstrap prompt.",
  "Do not answer yet. Wait for the follow-up prompt.",
].join("\n")

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

interface TaskResponse {
  readonly taskId: string
}

interface McpTasksWireOptions {
  readonly baseUrl: string
  readonly namespace: string
  readonly streamId: string
}

interface TaskEvent {
  readonly taskId: string
  readonly status: string
  readonly result?: unknown
}

interface StreamReadResult {
  readonly items: ReadonlyArray<unknown>
  readonly nextOffset: string
}

interface ScenarioResult {
  readonly sessionNewTaskId: string
  readonly sessionPromptTaskId: string
  readonly childSessionId: string
  readonly taskStatuses: string
  readonly sawInputRequired: boolean
  readonly sentTaskUpdate: boolean
  readonly resultHadMarker: boolean
  readonly permissionRoundtripCompleted: boolean
}

const nextRequestId = (() => {
  let next = 0
  return () => String(++next)
})()

const exitValue = (response: unknown): unknown => {
  if (typeof response !== "object" || response === null) return undefined
  const record = response as Record<string, unknown>
  if (record._tag !== "Exit") return undefined
  const exit = record.exit
  if (typeof exit !== "object" || exit === null) return undefined
  const encoded = exit as Record<string, unknown>
  return encoded._tag === "Success" ? encoded.value : undefined
}

const streamUrl = (wire: McpTasksWireOptions, suffix: string) => {
  const trimmed = wire.baseUrl.replace(/\/+$/, "")
  const separator = trimmed.includes("/v1/stream/") ? "/" : "/v1/stream/"
  const streamName = `${wire.namespace}.tiny-firegrid.${wire.streamId}.mcp-tasks.${suffix}`
  return `${trimmed}${separator}${encodeURIComponent(streamName)}`
}

const createStream = (wire: McpTasksWireOptions, suffix: string): Effect.Effect<void, unknown> =>
  Effect.tryPromise({
    try: signal =>
      globalThis.fetch(streamUrl(wire, suffix), {
        method: "PUT",
        headers: { "content-type": "application/json", connection: "close" },
        signal,
      }).then(async response => {
        await response.arrayBuffer()
        return response
      }),
    catch: cause => cause,
  }).pipe(Effect.asVoid, Effect.catchAll(() => Effect.void))

const createWireStreams = (wire: McpTasksWireOptions): Effect.Effect<void, unknown> =>
  Effect.all([
    createStream(wire, "requests"),
    createStream(wire, "responses"),
    createStream(wire, "task-events"),
  ], { discard: true })

const appendWire = (
  wire: McpTasksWireOptions,
  suffix: string,
  value: unknown,
): Effect.Effect<void, unknown> =>
  Effect.tryPromise({
    try: async signal => {
      const response = await globalThis.fetch(streamUrl(wire, suffix), {
        method: "POST",
        headers: { "content-type": "application/json", connection: "close" },
        body: JSON.stringify(value),
        signal,
      })
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`append ${suffix} failed with status ${response.status}`)
      }
      await response.arrayBuffer()
    },
    catch: cause => cause,
  })

const appendRequest = (
  wire: McpTasksWireOptions,
  message: unknown,
): Effect.Effect<void, unknown> =>
  appendWire(wire, "requests", { clientId: 1, message })

const readWire = (
  wire: McpTasksWireOptions,
  suffix: string,
  offset: string,
): Effect.Effect<StreamReadResult, unknown> =>
  Effect.tryPromise({
    try: async signal => {
      const url = new URL(streamUrl(wire, suffix))
      url.searchParams.set("offset", offset)
      url.searchParams.set("live", "long-poll")
      const response = await globalThis.fetch(url, {
        headers: { connection: "close" },
        signal,
      })
      if (response.status !== 200 && response.status !== 204) {
        throw new Error(`read ${suffix} failed with status ${response.status}`)
      }
      const nextOffset = response.headers.get("stream-next-offset") ?? offset
      if (response.status === 204) return { items: [], nextOffset }
      const body = await response.text()
      const parsed: unknown = body.trim() === "" ? [] : JSON.parse(body)
      return { items: Array.isArray(parsed) ? parsed : [parsed], nextOffset }
    },
    catch: cause => cause,
  })

const readStream = (wire: McpTasksWireOptions, suffix: string): Stream.Stream<unknown, unknown> =>
  Stream.unfoldEffect("-1", offset =>
    readWire(wire, suffix, offset).pipe(
      Effect.map(result => Option.some([result.items, result.nextOffset] as const)),
    )).pipe(Stream.flatMap(items => Stream.fromIterable(items)))

const readResponses = (wire: McpTasksWireOptions): Stream.Stream<unknown, unknown> =>
  readStream(wire, "responses").pipe(
    Stream.filter((event): event is { readonly clientId: number; readonly message: unknown } =>
      typeof event === "object" &&
      event !== null &&
      "clientId" in event &&
      event.clientId === 1 &&
      "message" in event),
    Stream.map(event => event.message),
  )

const taskEvents = (wire: McpTasksWireOptions): Stream.Stream<TaskEvent, unknown> =>
  readStream(wire, "task-events").pipe(
    Stream.filter((event): event is TaskEvent =>
      typeof event === "object" &&
      event !== null &&
      "taskId" in event &&
      typeof event.taskId === "string" &&
      "status" in event &&
      typeof event.status === "string"),
  )

const rpc = (
  wire: McpTasksWireOptions,
  tag: string,
  payload: unknown,
): Effect.Effect<unknown, unknown> =>
  Effect.gen(function*() {
    const id = nextRequestId()
    yield* appendRequest(wire, {
      _tag: "Request",
      id,
      tag,
      payload,
      headers: [],
    })
    const response = yield* readResponses(wire).pipe(
      Stream.filter(message =>
        typeof message === "object" &&
        message !== null &&
        "_tag" in message &&
        message._tag === "Exit" &&
        "requestId" in message &&
        message.requestId === id),
      Stream.runHead,
      Effect.timeoutFail({
        duration: Duration.seconds(90),
        onTimeout: () => new Error(`timed out waiting for ${tag}`),
      }),
      Effect.flatMap(Option.match({
        onNone: () => Effect.fail(new Error(`no response for ${tag}`)),
        onSome: Effect.succeed,
      })),
    )
    return exitValue(response)
  }).pipe(
    Effect.withSpan(`tiny_firegrid.mcp_tasks.rpc.${tag}`, {
      attributes: {
        "firegrid.mcp.method": tag,
      },
    }),
  )

const createTask = (
  wire: McpTasksWireOptions,
  name: string,
  args: Record<string, unknown>,
): Effect.Effect<TaskResponse, unknown> =>
  Effect.gen(function*() {
    const value = yield* rpc(wire, "tools/call", {
      name,
      arguments: args,
      task: {
        ttl: 120_000,
      },
    })
    const record = typeof value === "object" && value !== null
      ? value as Record<string, unknown>
      : {}
    const task = typeof record.task === "object" && record.task !== null
      ? record.task as Record<string, unknown>
      : {}
    const taskId = typeof task.taskId === "string" ? task.taskId : ""
    return { taskId }
  })

const taskResult = (
  wire: McpTasksWireOptions,
  taskId: string,
): Effect.Effect<unknown, unknown> =>
  rpc(wire, "tasks/result", { taskId })

const watchPromptTask = (
  wire: McpTasksWireOptions,
  taskId: string,
): Effect.Effect<{
  readonly statuses: ReadonlyArray<string>
  readonly sentUpdate: boolean
  readonly terminal: TaskEvent
}, unknown> =>
  Effect.gen(function*() {
    const statuses: Array<string> = []
    let sentUpdate = false
    const terminal = yield* taskEvents(wire).pipe(
      Stream.filter(event => event.taskId === taskId),
      Stream.tap(event =>
        Effect.gen(function*() {
          statuses.push(event.status)
          if (event.status === "input_required" && !sentUpdate) {
            sentUpdate = true
            yield* rpc(wire, "tasks/update", {
              taskId,
              input: {
                decision: { _tag: "Allow" },
              },
            })
          }
        })),
      Stream.filter(event =>
        event.status === "completed" ||
        event.status === "failed" ||
        event.status === "cancelled"),
      Stream.runHead,
      Effect.timeoutFail({
        duration: Duration.minutes(5),
        onTimeout: () => new Error("prompt task did not reach terminal status"),
      }),
      Effect.flatMap(Option.match({
        onNone: () => Effect.fail(new Error("prompt task stream ended before terminal status")),
        onSome: Effect.succeed,
      })),
    )
    return { statuses, sentUpdate, terminal }
  })

export const mcpTasksGatewayDriver: Effect.Effect<void, unknown, Firegrid | FiregridConfig> =
  Effect.scoped(Effect.gen(function*() {
    const anthropicKey = yield* anthropicKeyConfig
    if (Option.isNone(anthropicKey)) {
      yield* Effect.annotateCurrentSpan({
        "firegrid.mcp_tasks.status": "blocked",
        "firegrid.mcp_tasks.blocked_reason": "ANTHROPIC_API_KEY is absent",
        "firegrid.mcp_tasks.anthropic_api_key_present": false,
      })
      return
    }

    const firegrid = yield* Firegrid
    const config = yield* FiregridConfig
    if (config.durableStreamsBaseUrl === undefined || config.namespace === undefined) {
      return yield* Effect.fail(new Error("mcp tasks gateway requires durableStreamsBaseUrl and namespace"))
    }
    const parent = yield* firegrid.sessions.createOrLoad({
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

    const wire: McpTasksWireOptions = {
      baseUrl: config.durableStreamsBaseUrl,
      namespace: config.namespace,
      streamId,
    }
    yield* createWireStreams(wire)

    yield* rpc(wire, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tiny-firegrid-mcp-tasks-gateway", version: "0.0.0" },
    })
    yield* rpc(wire, "tools/list", {})

    const sessionNewTask = yield* createTask(wire, "session_new", {
      agentKind: "claude-acp",
      prompt: initialPrompt,
    })
    const sessionNewResult = yield* taskResult(wire, sessionNewTask.taskId)
    const newResultRecord = typeof sessionNewResult === "object" && sessionNewResult !== null
      ? sessionNewResult as Record<string, unknown>
      : {}
    const structured = typeof newResultRecord.structuredContent === "object" &&
        newResultRecord.structuredContent !== null
      ? newResultRecord.structuredContent as Record<string, unknown>
      : {}
    const session = typeof structured.session === "object" && structured.session !== null
      ? structured.session as Record<string, unknown>
      : {}
    const childSessionId = typeof session.sessionId === "string" ? session.sessionId : ""

    const sessionPromptTask = yield* createTask(wire, "session_prompt", {
      sessionId: childSessionId,
      prompt: promptText,
      inputId: "tiny-firegrid-mcp-tasks-prompt-1",
    })

    const watched = yield* watchPromptTask(wire, sessionPromptTask.taskId)
    const promptResult = yield* taskResult(wire, sessionPromptTask.taskId)
    const promptRecord = typeof promptResult === "object" && promptResult !== null
      ? promptResult as Record<string, unknown>
      : {}
    const promptContent = JSON.stringify(promptRecord)
    const promptStructured = typeof promptRecord.structuredContent === "object" &&
        promptRecord.structuredContent !== null
      ? promptRecord.structuredContent as Record<string, unknown>
      : {}
    const permissionRoundtripCompleted =
      promptStructured.permissionRoundtripCompleted === true
    const result: ScenarioResult = {
      sessionNewTaskId: sessionNewTask.taskId,
      sessionPromptTaskId: sessionPromptTask.taskId,
      childSessionId,
      taskStatuses: watched.statuses.join(","),
      sawInputRequired: watched.statuses.includes("input_required"),
      sentTaskUpdate: watched.sentUpdate,
      resultHadMarker: promptContent.includes(marker),
      permissionRoundtripCompleted,
    }

    yield* Effect.annotateCurrentSpan({
      "firegrid.mcp_tasks.status": "completed",
      "firegrid.mcp_tasks.anthropic_api_key_present": true,
      "firegrid.mcp_tasks.gateway_context_id": gatewayContextId,
      "firegrid.mcp_tasks.parent_session_id": parent.sessionId,
      "firegrid.mcp_tasks.session_new_task_id": result.sessionNewTaskId,
      "firegrid.mcp_tasks.session_prompt_task_id": result.sessionPromptTaskId,
      "firegrid.mcp_tasks.child_session_id": result.childSessionId,
      "firegrid.mcp_tasks.task_statuses": result.taskStatuses,
      "firegrid.mcp_tasks.saw_input_required": result.sawInputRequired,
      "firegrid.mcp_tasks.sent_task_update": result.sentTaskUpdate,
      "firegrid.mcp_tasks.result_had_marker": result.resultHadMarker,
      "firegrid.mcp_tasks.permission_roundtrip_completed": result.permissionRoundtripCompleted,
      "firegrid.mcp_tasks.spawn_target": claudeAcpArgv.join(" "),
    })
  })).pipe(
    Effect.withSpan("tiny_firegrid.mcp_tasks.driver", {
      kind: "client",
    }),
  )
