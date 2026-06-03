import { RpcServer } from "@effect/rpc"
import type * as RpcMessage from "@effect/rpc/RpcMessage"
import type { PermissionDecision } from "@firegrid/protocol/agent-tools"
import type { HostPermissionRespondChannel } from "@firegrid/protocol/channels"
import {
  runtimeContextsView,
  runtimeEventsForContextView,
  runtimeLogsForContextView,
  runtimeRunsForContextView,
  type RuntimeContext,
  type RuntimeEventRow,
  type RuntimeLogLineRow,
  type RuntimeRunEventRow,
} from "@firegrid/protocol/launch"
import {
  runtimeAgentOutputObservationFromRow,
  runtimePermissionRequestObservationFromAgentOutput,
  type RuntimeAgentOutputObservation,
  type SessionAgentOutputWaitInput,
  type SessionAgentOutputWaitOutput,
  type SessionPermissionRequestWaitInput,
  type SessionPermissionRequestWaitOutput,
} from "@firegrid/protocol/session-facade"
import { Data, Duration, Effect, Layer, Option, Ref, Stream } from "effect"
import {
  makeDurableStreamsProtocol,
  type FiregridMcpDurableStreamsWireOptions,
} from "./durable-streams-protocol.ts"

type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled"

interface SessionPromptTaskSpec {
  readonly operation: "session_prompt"
  readonly contextId: string
  readonly inputId: string
  readonly cursor: number
  readonly createdAt: string
  readonly ttl: number
  readonly pollInterval: number
}

interface ProjectedTask {
  readonly taskId: string
  readonly status: TaskStatus
  readonly statusMessage?: string
  readonly createdAt: string
  readonly lastUpdatedAt: string
  readonly ttl: number
  readonly pollInterval: number
  readonly inputRequest?: unknown
}

interface ProjectedPromptLifecycle {
  readonly task: ProjectedTask
  readonly result?: unknown
  readonly terminal: boolean
}

interface SessionPromptTaskInput {
  readonly taskId: string
  readonly contextId: string
  readonly permissionRequestId: string
}

interface McpTaskProjectionRuntime {
  readonly snapshot: (contextId: string) => Effect.Effect<ReadonlyArray<RuntimeAgentOutputObservation>, unknown>
  readonly live: (contextId: string) => Stream.Stream<RuntimeAgentOutputObservation, unknown>
  readonly respondToPermission: (input: {
    readonly contextId: string
    readonly permissionRequestId: string
    readonly decision: PermissionDecision
    readonly idempotencyKey: string
  }) => Effect.Effect<unknown, unknown>
}

interface RuntimeContextSnapshot {
  readonly contextId: string
  readonly runs: ReadonlyArray<RuntimeRunEventRow>
  readonly events: ReadonlyArray<RuntimeEventRow>
  readonly logs: ReadonlyArray<RuntimeLogLineRow>
  readonly agentOutputs: ReadonlyArray<RuntimeAgentOutputObservation>
  readonly status?: RuntimeRunEventRow["status"]
  readonly context?: RuntimeContext
}

interface McpObservationProjectionRuntime {
  readonly contexts: Effect.Effect<ReadonlyArray<RuntimeContext>, unknown>
  readonly snapshot: (contextId: string) => Effect.Effect<RuntimeContextSnapshot, unknown>
  readonly waitForAgentOutput: (
    contextId: string,
    input: SessionAgentOutputWaitInput,
  ) => Effect.Effect<SessionAgentOutputWaitOutput, unknown>
  readonly waitForPermissionRequest: (
    contextId: string,
    input: SessionPermissionRequestWaitInput,
  ) => Effect.Effect<SessionPermissionRequestWaitOutput, unknown>
}

interface McpProjectionRuntime extends McpTaskProjectionRuntime {
  readonly observations?: McpObservationProjectionRuntime
}

interface RuntimeControlRowsSource {
  readonly contexts: {
    readonly collection: {
      readonly toArray: ReadonlyArray<RuntimeContext>
    }
  }
  readonly runs: {
    readonly collection: {
      readonly toArray: ReadonlyArray<RuntimeRunEventRow>
    }
  }
}

interface RuntimeOutputRowsSource {
  readonly events: {
    readonly collection: {
      readonly toArray: ReadonlyArray<RuntimeEventRow>
    }
    readonly rows: () => Stream.Stream<RuntimeEventRow, unknown>
  }
  readonly logs: {
    readonly collection: {
      readonly toArray: ReadonlyArray<RuntimeLogLineRow>
    }
  }
}

class McpTaskProjectionError extends Data.TaggedError("McpTaskProjectionError")<{
  readonly message: string
}> {}

const projectionError = (cause: unknown): McpTaskProjectionError =>
  new McpTaskProjectionError({ message: String(cause) })

// effect-quality-allow-wall-clock
const nowIso = (): string => new Date().toISOString()

const relatedTaskMeta = (taskId: string) => ({
  "io.modelcontextprotocol/related-task": { taskId },
})

const successResponse = (
  requestId: string,
  value: unknown,
): RpcMessage.ResponseExitEncoded => ({
  _tag: "Exit",
  requestId,
  exit: { _tag: "Success", value },
})

const failureResponse = (
  requestId: string,
  message: string,
): RpcMessage.ResponseExitEncoded => ({
  _tag: "Exit",
  requestId,
  exit: {
    _tag: "Failure",
    cause: {
      _tag: "Fail",
      error: {
        _tag: "RequestError",
        method: "<firegrid-mcp-tasks>",
        reason: "Transport",
        error: message,
      },
    },
  },
})

const jsonResourceResponse = (
  uri: string,
  value: unknown,
) => ({
  contents: [{
    uri,
    mimeType: "application/json",
    text: JSON.stringify(value),
  }],
})

const contextsResourceUri = "firegrid://runtime/contexts"

const contextSnapshotResourceUri = (contextId: string) =>
  `firegrid://runtime/contexts/${encodeURIComponent(contextId)}/snapshot`

const parseNonNegativeInteger = (
  name: string,
  value: string | null,
): number | undefined => {
  if (value === null) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return parsed
}

const parseWaitInput = (
  uri: URL,
): SessionAgentOutputWaitInput => {
  const afterSequence = parseNonNegativeInteger("afterSequence", uri.searchParams.get("afterSequence"))
  const timeoutMs = parseNonNegativeInteger("timeoutMs", uri.searchParams.get("timeoutMs"))
  return {
    ...(afterSequence === undefined ? {} : { afterSequence }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }
}

const observationResourcePath = (
  uri: string,
): Effect.Effect<
  | { readonly _tag: "Contexts" }
  | { readonly _tag: "Snapshot"; readonly contextId: string }
  | { readonly _tag: "AgentOutputWait"; readonly contextId: string; readonly input: SessionAgentOutputWaitInput }
  | { readonly _tag: "PermissionRequestWait"; readonly contextId: string; readonly input: SessionPermissionRequestWaitInput },
  unknown
> =>
  Effect.try({
    try: () => {
      const parsed = new URL(uri)
      if (parsed.protocol !== "firegrid:" || parsed.hostname !== "runtime") {
        throw new Error(`unsupported Firegrid resource uri: ${uri}`)
      }
      if (parsed.pathname === "/contexts") return { _tag: "Contexts" as const }
      const parts = parsed.pathname.split("/").filter(part => part.length > 0)
      if (parts[0] !== "contexts" || parts[1] === undefined) {
        throw new Error(`unsupported Firegrid resource uri: ${uri}`)
      }
      const contextId = decodeURIComponent(parts[1])
      if (parts.length === 3 && parts[2] === "snapshot") {
        return { _tag: "Snapshot" as const, contextId }
      }
      if (parts.length === 4 && parts[2] === "agent-output" && parts[3] === "wait") {
        return { _tag: "AgentOutputWait" as const, contextId, input: parseWaitInput(parsed) }
      }
      if (parts.length === 4 && parts[2] === "permission-request" && parts[3] === "wait") {
        return { _tag: "PermissionRequestWait" as const, contextId, input: parseWaitInput(parsed) }
      }
      throw new Error(`unsupported Firegrid resource uri: ${uri}`)
    },
    catch: projectionError,
  })

const latestRunStatus = (
  events: ReadonlyArray<RuntimeRunEventRow>,
): RuntimeRunEventRow["status"] | undefined => {
  const rank = (status: RuntimeRunEventRow["status"]): number =>
    status === "started" ? 0 : status === "failed" ? 1 : 2
  return [...events].sort((left, right) =>
    left.at.localeCompare(right.at) ||
    rank(left.status) - rank(right.status),
  ).at(-1)?.status
}

const snapshotFromJournal = (
  contextId: string,
  inputs: {
    readonly context?: RuntimeContext
    readonly runs: ReadonlyArray<RuntimeRunEventRow>
    readonly events: ReadonlyArray<RuntimeEventRow>
    readonly logs: ReadonlyArray<RuntimeLogLineRow>
  },
): RuntimeContextSnapshot => {
  const events = inputs.events.filter(row => row.contextId === contextId)
  const agentOutputs = events.flatMap(row => {
    const observation = runtimeAgentOutputObservationFromRow(row)
    return Option.isSome(observation) ? [observation.value] : []
  })
  const logs = inputs.logs.filter(row => row.contextId === contextId)
  const runs = [...inputs.runs].sort((left, right) => left.at.localeCompare(right.at))
  const status = latestRunStatus(runs)
  return {
    contextId,
    ...(inputs.context === undefined ? {} : { context: inputs.context }),
    ...(status === undefined ? {} : { status }),
    runs,
    events,
    logs,
    agentOutputs,
  }
}

const encodeTaskId = (spec: SessionPromptTaskSpec): string =>
  `firegrid:session_prompt:${Buffer.from(JSON.stringify(spec), "utf8").toString("base64url")}`

const decodeTaskId = (taskId: string): Effect.Effect<SessionPromptTaskSpec, unknown> =>
  Effect.try({
    try: () => {
      const prefix = "firegrid:session_prompt:"
      if (!taskId.startsWith(prefix)) {
        throw new Error(`unsupported task id: ${taskId}`)
      }
      const parsed: unknown = JSON.parse(
        Buffer.from(taskId.slice(prefix.length), "base64url").toString("utf8"),
      )
      if (typeof parsed !== "object" || parsed === null) {
        throw new Error(`invalid task id payload: ${taskId}`)
      }
      const record = parsed as Record<string, unknown>
      if (
        record.operation !== "session_prompt" ||
        typeof record.contextId !== "string" ||
        typeof record.inputId !== "string" ||
        typeof record.cursor !== "number" ||
        typeof record.createdAt !== "string" ||
        typeof record.ttl !== "number" ||
        typeof record.pollInterval !== "number"
      ) {
        throw new Error(`invalid session_prompt task spec: ${taskId}`)
      }
      return {
        operation: record.operation,
        contextId: record.contextId,
        inputId: record.inputId,
        cursor: record.cursor,
        createdAt: record.createdAt,
        ttl: record.ttl,
        pollInterval: record.pollInterval,
      }
    },
    catch: projectionError,
  })

const taskObject = (
  taskId: string,
  spec: SessionPromptTaskSpec,
  status: TaskStatus,
  patch: {
    readonly statusMessage?: string
    readonly inputRequest?: unknown
    readonly lastUpdatedAt?: string
  } = {},
): ProjectedTask => ({
  taskId,
  status,
  ...(patch.statusMessage === undefined ? {} : { statusMessage: patch.statusMessage }),
  createdAt: spec.createdAt,
  lastUpdatedAt: patch.lastUpdatedAt ?? spec.createdAt,
  ttl: spec.ttl,
  pollInterval: spec.pollInterval,
  ...(patch.inputRequest === undefined ? {} : { inputRequest: patch.inputRequest }),
})

const textDelta = (observation: RuntimeAgentOutputObservation): string => {
  if (observation._tag !== "TextChunk") return ""
  return observation.event.part.delta
}

const callToolResult = (
  taskId: string,
  text: string,
  data: Record<string, unknown>,
  isError: boolean,
) => ({
  content: text.length === 0 ? [] : [{ type: "text", text }],
  structuredContent: data,
  isError,
  _meta: relatedTaskMeta(taskId),
})

const projectPromptLifecycle = (
  taskId: string,
  spec: SessionPromptTaskSpec,
  allObservations: ReadonlyArray<RuntimeAgentOutputObservation>,
): ProjectedPromptLifecycle => {
  const observations = allObservations
    .filter(observation => observation.sequence > spec.cursor)
    .sort((left, right) => left.sequence - right.sequence)
  const text = observations.map(textDelta).join("")
  const latest = observations.at(-1)
  const permission = observations
    .filter((observation): observation is Extract<RuntimeAgentOutputObservation, { readonly _tag: "PermissionRequest" }> =>
      observation._tag === "PermissionRequest" &&
      observation.permissionRequestId !== undefined)
    .at(-1)
  const eventTags = observations.map(observation => observation._tag)
  const outputCount = observations.length
  const lastUpdatedAt = latest === undefined ? spec.createdAt : nowIso()
  const permissionRoundtripCompleted = permission === undefined
    ? false
    : observations.some(observation => observation.sequence > permission.sequence)

  if (latest?._tag === "Error") {
    return {
      task: taskObject(taskId, spec, "failed", {
        lastUpdatedAt,
        statusMessage: "prompt lifecycle emitted Error",
      }),
      terminal: true,
      result: callToolResult(taskId, text, {
        contextId: spec.contextId,
        outputCount,
        outputTags: eventTags,
        permissionRoundtripCompleted,
      }, true),
    }
  }

  if (latest?._tag === "TurnComplete" || latest?._tag === "Terminated") {
    return {
      task: taskObject(taskId, spec, "completed", {
        lastUpdatedAt,
        statusMessage: "prompt lifecycle reached terminal output",
      }),
      terminal: true,
      result: callToolResult(taskId, text, {
        contextId: spec.contextId,
        outputCount,
        outputTags: eventTags,
        permissionRoundtripCompleted,
      }, false),
    }
  }

  if (
    permission !== undefined &&
    (latest === undefined || latest.sequence === permission.sequence)
  ) {
    return {
      task: taskObject(taskId, spec, "input_required", {
        lastUpdatedAt,
        statusMessage: "permission request waiting for task input",
        inputRequest: {
          permissionRequestId: permission.permissionRequestId,
          toolUseId: permission.toolUseId,
          options: permission.options,
          _meta: relatedTaskMeta(taskId),
        },
      }),
      terminal: false,
    }
  }

  return {
    task: taskObject(taskId, spec, "working", {
      lastUpdatedAt,
      statusMessage: latest === undefined
        ? "task accepted"
        : `latest output: ${latest._tag}`,
    }),
    terminal: false,
  }
}

const permissionDecisionFromUpdate = (payload: unknown): PermissionDecision => {
  const record = typeof payload === "object" && payload !== null
    ? payload as Record<string, unknown>
    : {}
  const input = typeof record.input === "object" && record.input !== null
    ? record.input as Record<string, unknown>
    : record
  const decision = input.decision
  if (typeof decision === "object" && decision !== null && "_tag" in decision) {
    const tagged = decision as { readonly _tag?: unknown; readonly optionId?: unknown; readonly reason?: unknown }
    if (tagged._tag === "Allow") {
      return {
        _tag: "Allow",
        ...(typeof tagged.optionId === "string" ? { optionId: tagged.optionId } : {}),
      }
    }
    if (tagged._tag === "Deny") {
      return {
        _tag: "Deny",
        ...(typeof tagged.reason === "string" ? { reason: tagged.reason } : {}),
      }
    }
    if (tagged._tag === "Cancelled") return { _tag: "Cancelled" }
  }
  return { _tag: "Allow" }
}

const toolsCallPayload = (message: RpcMessage.RequestEncoded) =>
  typeof message.payload === "object" && message.payload !== null
    ? message.payload as Record<string, unknown>
    : {}

const taskFromPayload = (payload: Record<string, unknown>) =>
  typeof payload.task === "object" && payload.task !== null
    ? payload.task as Record<string, unknown>
    : undefined

const toolArguments = (payload: Record<string, unknown>) =>
  typeof payload.arguments === "object" && payload.arguments !== null
    ? payload.arguments as Record<string, unknown>
    : {}

const sessionPromptTaskSupportTool = (tool: unknown) => {
  if (typeof tool !== "object" || tool === null) return tool
  const record = tool as Record<string, unknown>
  if (record.name !== "session_prompt") return tool
  const existing = typeof record.execution === "object" && record.execution !== null
    ? record.execution as Record<string, unknown>
    : {}
  return {
    ...record,
    execution: {
      ...existing,
      taskSupport: true,
    },
  }
}

const rewriteResult = (
  observations: McpObservationProjectionRuntime | undefined,
  requestTag: string | undefined,
  response: RpcMessage.FromServerEncoded,
): RpcMessage.FromServerEncoded => {
  if (response._tag !== "Exit" || response.exit._tag !== "Success") return response
  const value = response.exit.value
  if (requestTag === "initialize" && typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    const capabilities = typeof record.capabilities === "object" && record.capabilities !== null
      ? record.capabilities as Record<string, unknown>
      : {}
    return {
      ...response,
      exit: {
        ...response.exit,
        value: {
          ...record,
          capabilities: {
            ...capabilities,
            tasks: {
              get: true,
              result: true,
              update: true,
              cancel: false,
            },
            ...(observations === undefined
              ? {}
              : {
                resources: {
                  listChanged: true,
                  subscribe: false,
                },
              }),
          },
        },
      },
    }
  }
  if (requestTag === "tools/list" && typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    const tools = Array.isArray(record.tools)
      ? record.tools.map(sessionPromptTaskSupportTool)
      : record.tools
    return {
      ...response,
      exit: {
        ...response.exit,
        value: { ...record, tools },
      },
    }
  }
  return response
}

const latestTaskState = (
  runtime: McpTaskProjectionRuntime,
  taskId: string,
): Effect.Effect<ProjectedPromptLifecycle, unknown> =>
  Effect.gen(function*() {
    const spec = yield* decodeTaskId(taskId)
    const snapshot = yield* runtime.snapshot(spec.contextId)
    return projectPromptLifecycle(taskId, spec, snapshot)
  })

const awaitTaskResult = (
  runtime: McpTaskProjectionRuntime,
  taskId: string,
): Effect.Effect<unknown, unknown> =>
  Effect.gen(function*() {
    const spec = yield* decodeTaskId(taskId)
    const snapshot = yield* runtime.snapshot(spec.contextId)
    const snapshotState = projectPromptLifecycle(taskId, spec, snapshot)
    if (snapshotState.terminal) {
      return snapshotState.result ?? callToolResult(taskId, "", {
        contextId: spec.contextId,
        outputCount: 0,
        outputTags: [],
        permissionRoundtripCompleted: false,
      }, snapshotState.task.status !== "completed")
    }
    const state = yield* runtime.live(spec.contextId).pipe(
      Stream.filter(observation => observation.sequence > spec.cursor),
      Stream.runFoldWhile(
        snapshot.filter(observation => observation.sequence > spec.cursor),
        observations => !projectPromptLifecycle(taskId, spec, observations).terminal,
        (observations, observation) => [...observations, observation],
      ),
      Effect.timeoutFail({
        duration: Duration.minutes(5),
        onTimeout: () => new Error(`task ${taskId} did not reach terminal output`),
      }),
      Effect.map(observations => projectPromptLifecycle(taskId, spec, observations)),
    )
    return state.result ?? callToolResult(taskId, "", {
      contextId: spec.contextId,
      outputCount: 0,
      outputTags: [],
      permissionRoundtripCompleted: false,
    }, state.task.status !== "completed")
  })

const respondToTaskInput = (
  runtime: McpTaskProjectionRuntime,
  input: SessionPromptTaskInput,
  payload: unknown,
) =>
  runtime.respondToPermission({
    contextId: input.contextId,
    permissionRequestId: input.permissionRequestId,
    decision: permissionDecisionFromUpdate(payload),
    idempotencyKey: `mcp-task:${input.taskId}:${input.permissionRequestId}`,
  })

const makeTaskInput = (
  runtime: McpTaskProjectionRuntime,
  taskId: string,
): Effect.Effect<SessionPromptTaskInput, unknown> =>
  Effect.gen(function*() {
    const spec = yield* decodeTaskId(taskId)
    const state = yield* latestTaskState(runtime, taskId)
    const inputRequest = state.task.inputRequest
    const record = typeof inputRequest === "object" && inputRequest !== null
      ? inputRequest as Record<string, unknown>
      : {}
    const permissionRequestId = typeof record.permissionRequestId === "string"
      ? record.permissionRequestId
      : ""
    if (permissionRequestId.length === 0) {
      return yield* Effect.fail(new McpTaskProjectionError({
        message: `task ${taskId} is not waiting for permission input`,
      }))
    }
    return {
      taskId,
      contextId: spec.contextId,
      permissionRequestId,
    }
  })

const makeSessionPromptTask = (
  runtime: McpTaskProjectionRuntime,
  payload: Record<string, unknown>,
): Effect.Effect<{
  readonly taskId: string
  readonly forwardedPayload: Record<string, unknown>
  readonly task: ProjectedTask
}, unknown> =>
  Effect.gen(function*() {
    const args = toolArguments(payload)
    const contextId = typeof args.sessionId === "string" ? args.sessionId : ""
    if (contextId.length === 0) {
      return yield* Effect.fail(new McpTaskProjectionError({
        message: "session_prompt task requires arguments.sessionId",
      }))
    }
    const taskOptions = taskFromPayload(payload)
    const ttl = typeof taskOptions?.ttl === "number" ? taskOptions.ttl : 120_000
    const inputId = typeof args.inputId === "string" && args.inputId.length > 0
      ? args.inputId
      : `mcp-task:${globalThis.crypto.randomUUID()}`
    const snapshot = yield* runtime.snapshot(contextId)
    const cursor = snapshot.reduce(
      (max, observation) => Math.max(max, observation.sequence),
      -1,
    )
    const spec: SessionPromptTaskSpec = {
      operation: "session_prompt",
      contextId,
      inputId,
      cursor,
      createdAt: nowIso(),
      ttl,
      pollInterval: 500,
    }
    const taskId = encodeTaskId(spec)
    const task = taskObject(taskId, spec, "working", {
      statusMessage: "task accepted",
    })
    const forwardedPayload: Record<string, unknown> = {
      ...payload,
      arguments: {
        ...args,
        inputId,
      },
    }
    delete forwardedPayload.task
    return { taskId, forwardedPayload, task }
  })

const makeTaskProjectionProtocol = (
  options: FiregridMcpDurableStreamsWireOptions,
  runtime: McpProjectionRuntime,
) =>
  Effect.gen(function*() {
    const requestTags = yield* Ref.make(new Map<string, string>())
    const taskRequestIds = yield* Ref.make(new Set<string>())

    return yield* makeDurableStreamsProtocol(options, {
      onRequest: ({ clientId, message, writeRequest, sendToClient }) =>
        Effect.gen(function*() {
          if (message._tag !== "Request") {
            yield* writeRequest(clientId, message)
            return
          }

          const request = message
          yield* Ref.update(requestTags, map => new Map(map).set(request.id, request.tag))

          if (request.tag === "tools/call") {
            const payload = toolsCallPayload(request)
            if (payload.name === "session_prompt" && taskFromPayload(payload) !== undefined) {
              const task = yield* makeSessionPromptTask(runtime, payload)
              yield* Ref.update(taskRequestIds, set => new Set(set).add(request.id))
              yield* sendToClient(clientId, successResponse(request.id, {
                task: task.task,
                _meta: {
                  "io.modelcontextprotocol/model-immediate-response":
                    `Firegrid task ${task.taskId} is working.`,
                },
              }))
              yield* writeRequest(clientId, {
                ...request,
                payload: task.forwardedPayload,
              })
              return
            }
          }

          if (request.tag === "tasks/get") {
            const payload = toolsCallPayload(request)
            const taskId = typeof payload.taskId === "string" ? payload.taskId : ""
            const state = yield* latestTaskState(runtime, taskId)
            yield* sendToClient(clientId, successResponse(request.id, state.task))
            return
          }

          if (request.tag === "tasks/result") {
            const payload = toolsCallPayload(request)
            const taskId = typeof payload.taskId === "string" ? payload.taskId : ""
            const result = yield* awaitTaskResult(runtime, taskId)
            yield* sendToClient(clientId, successResponse(request.id, result))
            return
          }

          if (request.tag === "tasks/update") {
            const payload = toolsCallPayload(request)
            const taskId = typeof payload.taskId === "string" ? payload.taskId : ""
            const input = yield* makeTaskInput(runtime, taskId)
            yield* respondToTaskInput(runtime, input, payload)
            yield* sendToClient(clientId, successResponse(request.id, {
              taskId,
              accepted: true,
            }))
            return
          }

          if (runtime.observations !== undefined && request.tag === "resources/list") {
            const contexts = yield* runtime.observations.contexts
            yield* sendToClient(clientId, successResponse(request.id, {
              resources: [
                {
                  uri: contextsResourceUri,
                  name: "Firegrid runtime contexts",
                  mimeType: "application/json",
                },
                ...contexts.map(context => ({
                  uri: contextSnapshotResourceUri(context.contextId),
                  name: `Firegrid runtime snapshot: ${context.contextId}`,
                  mimeType: "application/json",
                })),
              ],
            }))
            return
          }

          if (runtime.observations !== undefined && request.tag === "resources/read") {
            const payload = toolsCallPayload(request)
            const uri = typeof payload.uri === "string" ? payload.uri : ""
            const resource = yield* observationResourcePath(uri)
            const readResource = resource._tag === "Contexts"
              ? runtime.observations.contexts
              : resource._tag === "Snapshot"
              ? runtime.observations.snapshot(resource.contextId)
              : resource._tag === "AgentOutputWait"
              ? runtime.observations.waitForAgentOutput(resource.contextId, resource.input)
              : runtime.observations.waitForPermissionRequest(resource.contextId, resource.input)
            const value = yield* readResource
            yield* sendToClient(clientId, successResponse(request.id, jsonResourceResponse(uri, value)))
            return
          }

          yield* writeRequest(clientId, request)
        }).pipe(
          Effect.catchAllCause(cause =>
            message._tag === "Request"
              ? sendToClient(clientId, failureResponse(message.id, cause.toString()))
              : Effect.logError(`mcp task projection request failed: ${cause.toString()}`)),
        ),

      onResponse: ({ clientId, response, sendToClient }) =>
        Effect.gen(function*() {
          if (response._tag === "Exit") {
            const isTaskRequest = (yield* Ref.get(taskRequestIds)).has(response.requestId)
            if (isTaskRequest) return
          }
          const tag = response._tag === "Exit"
            ? (yield* Ref.get(requestTags)).get(response.requestId)
            : undefined
          yield* sendToClient(clientId, rewriteResult(runtime.observations, tag, response))
        }).pipe(Effect.orDie),
    })
  })

export const makeRuntimeOutputTaskProjectionRuntime = (
  output: RuntimeOutputRowsSource,
  permissionRespond: HostPermissionRespondChannel["Type"],
): McpTaskProjectionRuntime => ({
  snapshot: (contextId: string) =>
    runtimeEventsForContextView(
      Stream.fromIterable(output.events.collection.toArray),
      contextId,
    ).pipe(
      Stream.filterMap(runtimeAgentOutputObservationFromRow),
      Stream.runCollect,
      Effect.map(chunk => Array.from(chunk)),
    ),
  live: (contextId: string) =>
    runtimeEventsForContextView(output.events.rows(), contextId).pipe(
      Stream.filterMap(runtimeAgentOutputObservationFromRow),
    ),
  respondToPermission: input =>
    permissionRespond.binding.append({
      contextId: input.contextId,
      permissionRequestId: input.permissionRequestId,
      decision: input.decision,
      idempotencyKey: input.idempotencyKey,
    }),
})

const collectRows = <A>(
  rows: Stream.Stream<A, unknown>,
): Effect.Effect<ReadonlyArray<A>, unknown> =>
  rows.pipe(
    Stream.runCollect,
    Effect.map(chunk => Array.from(chunk)),
  )

const waitForAgentOutputObservation = (
  output: RuntimeOutputRowsSource,
  contextId: string,
  input: SessionAgentOutputWaitInput,
  predicate: (observation: RuntimeAgentOutputObservation) => boolean = () => true,
): Effect.Effect<Option.Option<RuntimeAgentOutputObservation>, unknown> => {
  const run = runtimeEventsForContextView(output.events.rows(), contextId).pipe(
    Stream.filterMap(runtimeAgentOutputObservationFromRow),
    Stream.filter(observation =>
      (input.afterSequence === undefined ||
        observation.sequence > input.afterSequence) &&
      predicate(observation)),
    Stream.runHead,
  )
  return input.timeoutMs === undefined
    ? run
    : Effect.raceFirst(
      run,
      Effect.sleep(Duration.millis(input.timeoutMs)).pipe(
        Effect.as(Option.none<RuntimeAgentOutputObservation>()),
      ),
    )
}

export const makeRuntimeTaskAndObservationProjectionRuntime = (
  control: RuntimeControlRowsSource,
  output: RuntimeOutputRowsSource,
  permissionRespond: HostPermissionRespondChannel["Type"],
): McpProjectionRuntime => ({
  ...makeRuntimeOutputTaskProjectionRuntime(output, permissionRespond),
  observations: {
    contexts: Effect.suspend(() =>
      collectRows(runtimeContextsView(
        Stream.fromIterable(control.contexts.collection.toArray),
      ))),
    snapshot: (contextId: string) =>
      Effect.gen(function*() {
        const contexts = yield* collectRows(runtimeContextsView(
          Stream.fromIterable(control.contexts.collection.toArray),
        ))
        const context = contexts.find(row => row.contextId === contextId)
        const runs = yield* collectRows(runtimeRunsForContextView(
          Stream.fromIterable(control.runs.collection.toArray),
          contextId,
        ))
        const events = yield* collectRows(runtimeEventsForContextView(
          Stream.fromIterable(output.events.collection.toArray),
          contextId,
        ))
        const logs = yield* collectRows(runtimeLogsForContextView(
          Stream.fromIterable(output.logs.collection.toArray),
          contextId,
        ))
        return snapshotFromJournal(contextId, {
          ...(context === undefined ? {} : { context }),
          runs,
          events,
          logs,
        })
      }),
    waitForAgentOutput: (contextId: string, input: SessionAgentOutputWaitInput) =>
      waitForAgentOutputObservation(output, contextId, input).pipe(
        Effect.map(Option.match({
          onNone: () => ({ matched: false, timedOut: true }) as const,
          onSome: output => ({ matched: true, output }) as const,
        })),
      ),
    waitForPermissionRequest: (contextId: string, input: SessionPermissionRequestWaitInput) =>
      waitForAgentOutputObservation(
        output,
        contextId,
        input,
        observation => Option.isSome(runtimePermissionRequestObservationFromAgentOutput(observation)),
      ).pipe(
        Effect.map(Option.match({
          onNone: () => ({ matched: false, timedOut: true }) as const,
          onSome: output => {
            const request = runtimePermissionRequestObservationFromAgentOutput(output)
            return Option.isSome(request)
              ? ({ matched: true, request: request.value } as const)
              : ({ matched: false, timedOut: true } as const)
          },
        })),
      ),
  },
})

export const layerProtocolDurableStreamsWithSessionPromptTasks = (
  options: FiregridMcpDurableStreamsWireOptions,
  runtime: McpProjectionRuntime,
): Layer.Layer<RpcServer.Protocol> =>
  Layer.scoped(
    RpcServer.Protocol,
    makeTaskProjectionProtocol(options, runtime).pipe(Effect.orDie),
  )
