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
  id: "mcp-production-task-projection-parent",
} as const

const gatewayContextId = `session:${gatewayExternalKey.source}:${gatewayExternalKey.id}`
const streamId = "mcp-production-task-projection"
const marker = "MCP_PRODUCTION_TASK_PROJECTION_DONE"

interface McpWireOptions {
  readonly baseUrl: string
  readonly namespace: string
  readonly streamId: string
}

interface StreamReadResult {
  readonly items: ReadonlyArray<unknown>
  readonly nextOffset: string
}

interface TaskResponse {
  readonly taskId: string
}

interface ProjectedTask {
  readonly taskId: string
  readonly status: string
  readonly inputRequest?: unknown
}

interface ScenarioResult {
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

const streamName = (
  wire: McpWireOptions,
  suffix: "requests" | "responses",
) =>
  `${wire.namespace}.firegrid.mcp.${wire.streamId}.${suffix}`

const streamUrl = (
  wire: McpWireOptions,
  suffix: "requests" | "responses",
) => {
  const trimmed = wire.baseUrl.replace(/\/+$/, "")
  const separator = trimmed.includes("/v1/stream/") ? "/" : "/v1/stream/"
  return `${trimmed}${separator}${encodeURIComponent(streamName(wire, suffix))}`
}

const createStream = (
  wire: McpWireOptions,
  suffix: "requests" | "responses",
): Effect.Effect<void, unknown> =>
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

const createWireStreams = (wire: McpWireOptions): Effect.Effect<void, unknown> =>
  Effect.all([
    createStream(wire, "requests"),
    createStream(wire, "responses"),
  ], { discard: true })

const appendRequest = (
  wire: McpWireOptions,
  message: unknown,
): Effect.Effect<void, unknown> =>
  Effect.tryPromise({
    try: async signal => {
      const response = await globalThis.fetch(streamUrl(wire, "requests"), {
        method: "POST",
        headers: { "content-type": "application/json", connection: "close" },
        body: JSON.stringify({ clientId: 1, message }),
        signal,
      })
      await response.arrayBuffer()
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`append request failed with status ${response.status}`)
      }
    },
    catch: cause => cause,
  })

const readWire = (
  wire: McpWireOptions,
  suffix: "requests" | "responses",
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

const readStream = (
  wire: McpWireOptions,
  suffix: "requests" | "responses",
): Stream.Stream<unknown, unknown> =>
  Stream.unfoldEffect("-1", offset =>
    readWire(wire, suffix, offset).pipe(
      Effect.map(result => Option.some([result.items, result.nextOffset] as const)),
    )).pipe(Stream.flatMap(items => Stream.fromIterable(items)))

const readResponses = (wire: McpWireOptions): Stream.Stream<unknown, unknown> =>
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
  wire: McpWireOptions,
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
    Effect.withSpan(`tiny_firegrid.mcp_production_task_projection.rpc.${tag}`, {
      attributes: {
        "firegrid.mcp.method": tag,
      },
    }),
  )

const createPromptTask = (
  wire: McpWireOptions,
  args: Record<string, unknown>,
): Effect.Effect<TaskResponse, unknown> =>
  Effect.gen(function*() {
    const value = yield* rpc(wire, "tools/call", {
      name: "session_prompt",
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
    if (taskId.length === 0) {
      return yield* Effect.fail(new Error("session_prompt task response did not include task.taskId"))
    }
    return { taskId }
  })

const taskGet = (
  wire: McpWireOptions,
  taskId: string,
): Effect.Effect<ProjectedTask, unknown> =>
  Effect.gen(function*() {
    const value = yield* rpc(wire, "tasks/get", { taskId })
    const record = typeof value === "object" && value !== null
      ? value as Record<string, unknown>
      : {}
    const status = typeof record.status === "string" ? record.status : "unknown"
    return {
      taskId,
      status,
      ...(record.inputRequest === undefined ? {} : { inputRequest: record.inputRequest }),
    }
  })

const taskResult = (
  wire: McpWireOptions,
  taskId: string,
): Effect.Effect<unknown, unknown> =>
  rpc(wire, "tasks/result", { taskId })

const terminalStatuses = new Set(["completed", "failed", "cancelled"])

const watchPromptTask = (
  wire: McpWireOptions,
  taskId: string,
): Effect.Effect<{
  readonly statuses: ReadonlyArray<string>
  readonly sentUpdate: boolean
  readonly terminal: ProjectedTask
}, unknown> =>
  Effect.gen(function*() {
    const statuses: Array<string> = []
    let sentUpdate = false
    let terminal: ProjectedTask | undefined
    while (terminal === undefined) {
      const task = yield* taskGet(wire, taskId)
      statuses.push(task.status)
      if (task.status === "input_required" && !sentUpdate) {
        sentUpdate = true
        yield* rpc(wire, "tasks/update", {
          taskId,
          input: {
            decision: { _tag: "Allow" },
          },
        })
      }
      if (terminalStatuses.has(task.status)) {
        terminal = task
      } else {
        // eslint-disable-next-line local/no-fixed-polling -- MCP Tasks explicitly permits clients to poll tasks/get; this is the client-side protocol driver, not runtime work scheduling.
        yield* Effect.sleep(Duration.millis(500))
      }
    }
    return { statuses, sentUpdate, terminal }
  }).pipe(
    Effect.timeoutFail({
      duration: Duration.minutes(5),
      onTimeout: () => new Error("prompt task did not reach terminal status"),
    }),
  )

export const mcpProductionTaskProjectionDriver: Effect.Effect<void, unknown, Firegrid | FiregridConfig> =
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

    const firegrid = yield* Firegrid
    const config = yield* FiregridConfig
    if (config.durableStreamsBaseUrl === undefined || config.namespace === undefined) {
      return yield* Effect.fail(new Error("mcp production task projection requires durableStreamsBaseUrl and namespace"))
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

    const child = yield* firegrid.sessions.createOrLoad({
      externalKey: {
        source: "tiny-firegrid",
        id: "mcp-production-task-projection-child",
      },
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

    const wire: McpWireOptions = {
      baseUrl: config.durableStreamsBaseUrl,
      namespace: config.namespace,
      streamId,
    }
    yield* createWireStreams(wire)

    yield* rpc(wire, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tiny-firegrid-mcp-production-task-projection", version: "0.0.0" },
    })
    yield* rpc(wire, "tools/list", {})

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

    const sessionPromptTask = yield* createPromptTask(wire, {
      sessionId: child.sessionId,
      prompt: promptText,
      inputId: "tiny-firegrid-mcp-production-task-projection-prompt-1",
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
    const result: ScenarioResult = {
      sessionPromptTaskId: sessionPromptTask.taskId,
      childSessionId: child.sessionId,
      taskStatuses: watched.statuses.join(","),
      sawInputRequired: watched.statuses.includes("input_required"),
      sentTaskUpdate: watched.sentUpdate,
      resultHadMarker: promptContent.includes(marker),
      permissionRoundtripCompleted:
        promptStructured.permissionRoundtripCompleted === true,
    }

    yield* Effect.annotateCurrentSpan({
      "firegrid.mcp_production_tasks.status": "completed",
      "firegrid.mcp_production_tasks.anthropic_api_key_present": true,
      "firegrid.mcp_production_tasks.gateway_context_id": gatewayContextId,
      "firegrid.mcp_production_tasks.session_prompt_task_id": result.sessionPromptTaskId,
      "firegrid.mcp_production_tasks.child_session_id": result.childSessionId,
      "firegrid.mcp_production_tasks.task_statuses": result.taskStatuses,
      "firegrid.mcp_production_tasks.saw_input_required": result.sawInputRequired,
      "firegrid.mcp_production_tasks.sent_task_update": result.sentTaskUpdate,
      "firegrid.mcp_production_tasks.result_had_marker": result.resultHadMarker,
      "firegrid.mcp_production_tasks.permission_roundtrip_completed": result.permissionRoundtripCompleted,
      "firegrid.mcp_production_tasks.spawn_target": claudeAcpArgv.join(" "),
    })
  })).pipe(
    Effect.withSpan("tiny_firegrid.mcp_production_task_projection.driver", {
      kind: "client",
    }),
  )
