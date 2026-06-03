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

const sessionExternalKey = {
  source: "tiny-firegrid",
  id: "mcp-task-projection-session",
} as const

const gatewayExternalKey = {
  source: "tiny-firegrid",
  id: "mcp-task-projection-parent",
} as const

const streamId = "mcp-task-projection-gateway"

const marker = "MCP_TASK_PROJECTION_DONE"

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

interface TaskResponse {
  readonly taskId: string
}

interface McpTaskProjectionWireOptions {
  readonly baseUrl: string
  readonly namespace: string
  readonly streamId: string
}

interface ProjectedTaskSnapshot {
  readonly taskId: string
  readonly status: string
  readonly inputRequest?: unknown
}

interface StreamReadResult {
  readonly items: ReadonlyArray<unknown>
  readonly nextOffset: string
}

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

const streamUrl = (wire: McpTaskProjectionWireOptions, suffix: string) => {
  const trimmed = wire.baseUrl.replace(/\/+$/, "")
  const separator = trimmed.includes("/v1/stream/") ? "/" : "/v1/stream/"
  const streamName = `${wire.namespace}.tiny-firegrid.${wire.streamId}.mcp-task-projection.${suffix}`
  return `${trimmed}${separator}${encodeURIComponent(streamName)}`
}

const createStream = (wire: McpTaskProjectionWireOptions, suffix: string): Effect.Effect<void, unknown> =>
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

const createWireStreams = (wire: McpTaskProjectionWireOptions): Effect.Effect<void, unknown> =>
  Effect.all([
    createStream(wire, "requests"),
    createStream(wire, "responses"),
  ], { discard: true })

const appendWire = (
  wire: McpTaskProjectionWireOptions,
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
  wire: McpTaskProjectionWireOptions,
  message: unknown,
): Effect.Effect<void, unknown> =>
  appendWire(wire, "requests", { clientId: 1, message })

const readWire = (
  wire: McpTaskProjectionWireOptions,
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

const readStream = (wire: McpTaskProjectionWireOptions, suffix: string): Stream.Stream<unknown, unknown> =>
  Stream.unfoldEffect("-1", offset =>
    readWire(wire, suffix, offset).pipe(
      Effect.map(result => Option.some([result.items, result.nextOffset] as const)),
    )).pipe(Stream.flatMap(items => Stream.fromIterable(items)))

const readResponses = (wire: McpTaskProjectionWireOptions): Stream.Stream<unknown, unknown> =>
  readStream(wire, "responses").pipe(
    Stream.filter((event): event is { readonly clientId: number; readonly message: unknown } =>
      typeof event === "object" &&
      event !== null &&
      "clientId" in event &&
      event.clientId === 1 &&
      "message" in event),
    Stream.map(event => event.message),
  )

const rpc = (
  wire: McpTaskProjectionWireOptions,
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
    Effect.withSpan(`tiny_firegrid.mcp_task_projection.rpc.${tag}`, {
      attributes: {
        "firegrid.mcp.method": tag,
      },
    }),
  )

const createTask = (
  wire: McpTaskProjectionWireOptions,
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

const taskGet = (
  wire: McpTaskProjectionWireOptions,
  taskId: string,
): Effect.Effect<ProjectedTaskSnapshot, unknown> =>
  Effect.gen(function*() {
    const value = yield* rpc(wire, "tasks/get", { taskId })
    const record = typeof value === "object" && value !== null
      ? value as Record<string, unknown>
      : {}
    return {
      taskId: typeof record.taskId === "string" ? record.taskId : taskId,
      status: typeof record.status === "string" ? record.status : "unknown",
      ...(record.inputRequest === undefined ? {} : { inputRequest: record.inputRequest }),
    }
  })

const taskResult = (
  wire: McpTaskProjectionWireOptions,
  taskId: string,
): Effect.Effect<unknown, unknown> =>
  rpc(wire, "tasks/result", { taskId })

const pollPromptTask = (
  wire: McpTaskProjectionWireOptions,
  taskId: string,
): Effect.Effect<{
  readonly statuses: ReadonlyArray<string>
  readonly sentUpdate: boolean
  readonly restartRehydrationGetWorked: boolean
}, unknown> =>
  Effect.gen(function*() {
    const statuses: Array<string> = []
    let sentUpdate = false
    let restartRehydrationGetWorked = false
    while (true) {
      const snapshot = yield* taskGet(wire, taskId)
      restartRehydrationGetWorked = restartRehydrationGetWorked || snapshot.status === "working"
      statuses.push(snapshot.status)
      if (snapshot.status === "input_required" && !sentUpdate) {
        sentUpdate = true
        yield* rpc(wire, "tasks/update", {
          taskId,
          input: {
            decision: { _tag: "Allow" },
          },
        })
      }
      if (
        snapshot.status === "completed" ||
        snapshot.status === "failed" ||
        snapshot.status === "cancelled"
      ) {
        return { statuses, sentUpdate, restartRehydrationGetWorked }
      }
      // eslint-disable-next-line local/no-fixed-polling -- MCP Tasks clients poll tasks/get; this sim validates that contract.
      yield* Effect.sleep(Duration.millis(500))
    }
  }).pipe(
    Effect.timeoutFail({
      duration: Duration.minutes(5),
      onTimeout: () => new Error("projected prompt task did not reach terminal status"),
    }),
  )

export const mcpTaskProjectionGatewayDriver: Effect.Effect<void, unknown, Firegrid | FiregridConfig> =
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

    const firegrid = yield* Firegrid
    const config = yield* FiregridConfig
    if (config.durableStreamsBaseUrl === undefined || config.namespace === undefined) {
      return yield* Effect.fail(new Error("mcp task projection requires durableStreamsBaseUrl and namespace"))
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

    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: sessionExternalKey,
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

    const wire: McpTaskProjectionWireOptions = {
      baseUrl: config.durableStreamsBaseUrl,
      namespace: config.namespace,
      streamId,
    }
    yield* createWireStreams(wire)

    yield* rpc(wire, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tiny-firegrid-mcp-task-projection", version: "0.0.0" },
    })
    yield* rpc(wire, "tools/list", {})

    const sessionPromptTask = yield* createTask(wire, "session_prompt", {
      sessionId: session.sessionId,
      prompt: promptText(
        `packages/tiny-firegrid/.simulate/mcp-task-projection-permission-probe-${globalThis.crypto.randomUUID()}.txt`,
      ),
      inputId: "tiny-firegrid-mcp-task-projection-prompt-1",
    })

    const watched = yield* pollPromptTask(wire, sessionPromptTask.taskId)
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
    const projectedFromRuntimeOutput =
      promptStructured.projectedFrom === "runtime-output"
    const result: ScenarioResult = {
      sessionPromptTaskId: sessionPromptTask.taskId,
      sessionId: session.sessionId,
      taskStatuses: watched.statuses.join(","),
      sawInputRequired: watched.statuses.includes("input_required"),
      sentTaskUpdate: watched.sentUpdate,
      resultHadMarker: promptContent.includes(marker),
      permissionRoundtripCompleted,
      projectedFromRuntimeOutput,
      restartRehydrationGetWorked: watched.restartRehydrationGetWorked,
    }

    yield* Effect.annotateCurrentSpan({
      "firegrid.mcp_task_projection.status": "completed",
      "firegrid.mcp_task_projection.anthropic_api_key_present": true,
      "firegrid.mcp_task_projection.session_prompt_task_id": result.sessionPromptTaskId,
      "firegrid.mcp_task_projection.session_id": result.sessionId,
      "firegrid.mcp_task_projection.task_statuses": result.taskStatuses,
      "firegrid.mcp_task_projection.saw_input_required": result.sawInputRequired,
      "firegrid.mcp_task_projection.sent_task_update": result.sentTaskUpdate,
      "firegrid.mcp_task_projection.result_had_marker": result.resultHadMarker,
      "firegrid.mcp_task_projection.permission_roundtrip_completed": result.permissionRoundtripCompleted,
      "firegrid.mcp_task_projection.projected_from_runtime_output": result.projectedFromRuntimeOutput,
      "firegrid.mcp_task_projection.restart_rehydration_get_worked": result.restartRehydrationGetWorked,
      "firegrid.mcp_task_projection.spawn_target": claudeAcpArgv.join(" "),
    })
  })).pipe(
    Effect.withSpan("tiny_firegrid.mcp_task_projection.driver", {
      kind: "client",
    }),
  )
