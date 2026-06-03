import { FetchHttpClient } from "@effect/platform"
import { McpServer } from "@effect/ai"
import { RpcServer } from "@effect/rpc"
import type * as RpcMessage from "@effect/rpc/RpcMessage"
import { Clock, Duration, Effect, Layer, Mailbox, Option, Ref, Stream } from "effect"
import type { RuntimeAgentOutputObservation } from "@firegrid/protocol/session-facade"
import {
  readRequestMessages,
  responseStream,
  type McpTaskProjectionWireOptions,
  type WireRpcMessage,
} from "./wire.ts"

type ProjectedTaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled"

interface PermissionRespondInput {
  readonly contextId: string
  readonly permissionRequestId: string
  readonly decision: unknown
  readonly idempotencyKey: string
}

type PermissionRespondAppend = (
  input: PermissionRespondInput,
) => Effect.Effect<unknown, unknown>

interface ProjectedSessionPromptTask {
  readonly v: 1
  readonly op: "session_prompt"
  readonly sessionId: string
  readonly inputId: string
  readonly afterSequence: number
  readonly createdAtMs: number
  readonly ttlMs: number
  readonly promptMarker: string | undefined
}

interface ProjectedTask {
  readonly taskId: string
  readonly spec: ProjectedSessionPromptTask
}

interface ProjectedTaskState {
  readonly task: ProjectedTask
  readonly status: ProjectedTaskStatus
  readonly statusMessage: string
  readonly observations: ReadonlyArray<RuntimeAgentOutputObservation>
  readonly text: string
  readonly inputRequest?: TaskInputRequest
  readonly permissionRequestId: string | undefined
  readonly markerObserved: boolean
  readonly permissionRoundtripCompleted: boolean
}

interface TaskInputRequest {
  readonly permissionRequestId: string | undefined
  readonly toolUseId: string | undefined
  readonly options: unknown
  readonly _meta: ReturnType<typeof relatedTaskMeta>
}

interface ProjectionRuntime {
  readonly outputSnapshot: (
    contextId: string,
  ) => Effect.Effect<ReadonlyArray<RuntimeAgentOutputObservation>, unknown>
  readonly outputStream: (
    contextId: string,
  ) => Stream.Stream<RuntimeAgentOutputObservation, unknown>
  readonly permissionRespondAppend: PermissionRespondAppend
  readonly restartIngress: Effect.Effect<void, unknown>
}

const taskPrefix = "fg.session_prompt."

const successResponse = (
  requestId: string,
  value: unknown,
): RpcMessage.ResponseExitEncoded => ({
  _tag: "Exit",
  requestId,
  exit: { _tag: "Success", value },
})

const relatedTaskMeta = (taskId: string) => ({
  "io.modelcontextprotocol/related-task": { taskId },
})

const parseRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : {}

const toolsCallPayload = (message: RpcMessage.RequestEncoded) =>
  parseRecord(message.payload)

const taskFromPayload = (payload: Record<string, unknown>) =>
  typeof payload.task === "object" && payload.task !== null
    ? payload.task as Record<string, unknown>
    : undefined

const toolArguments = (payload: Record<string, unknown>) =>
  typeof payload.arguments === "object" && payload.arguments !== null
    ? payload.arguments as Record<string, unknown>
    : {}

const taskSupportTool = (tool: unknown) => {
  if (typeof tool !== "object" || tool === null) return tool
  const record = tool as Record<string, unknown>
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
          },
        },
      },
    }
  }
  if (requestTag === "tools/list" && typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    const tools = Array.isArray(record.tools)
      ? record.tools.map(taskSupportTool)
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

const encodeTaskId = (spec: ProjectedSessionPromptTask): string =>
  `${taskPrefix}${encodeURIComponent(JSON.stringify(spec))}`

const decodeTaskId = (taskId: string): Option.Option<ProjectedTask> => {
  if (!taskId.startsWith(taskPrefix)) return Option.none()
  try {
    const decoded: unknown = JSON.parse(decodeURIComponent(taskId.slice(taskPrefix.length)))
    const record = parseRecord(decoded)
    if (
      record.v !== 1 ||
      record.op !== "session_prompt" ||
      typeof record.sessionId !== "string" ||
      typeof record.inputId !== "string" ||
      typeof record.afterSequence !== "number" ||
      typeof record.createdAtMs !== "number" ||
      typeof record.ttlMs !== "number"
    ) {
      return Option.none()
    }
    return Option.some({
      taskId,
      spec: {
        v: 1,
        op: "session_prompt",
        sessionId: record.sessionId,
        inputId: record.inputId,
        afterSequence: record.afterSequence,
        createdAtMs: record.createdAtMs,
        ttlMs: record.ttlMs,
        promptMarker: typeof record.promptMarker === "string" ? record.promptMarker : undefined,
      },
    })
  } catch {
    return Option.none()
  }
}

const textDelta = (observation: RuntimeAgentOutputObservation): string => {
  if (observation._tag !== "TextChunk") return ""
  const part = parseRecord(observation.event.part)
  return typeof part.delta === "string" ? part.delta : ""
}

const inputRequestFromPermission = (
  taskId: string,
  observation: RuntimeAgentOutputObservation,
): TaskInputRequest | undefined => {
  if (observation._tag !== "PermissionRequest") return undefined
  return {
    permissionRequestId: observation.permissionRequestId,
    toolUseId: observation.toolUseId,
    options: observation.options,
    _meta: relatedTaskMeta(taskId),
  }
}

const outputAfterCursor = (
  task: ProjectedTask,
  observations: ReadonlyArray<RuntimeAgentOutputObservation>,
) =>
  observations
    .filter(observation => observation.sequence > task.spec.afterSequence)
    .sort((left, right) => left.sequence - right.sequence)

const projectTaskState = (
  task: ProjectedTask,
  observations: ReadonlyArray<RuntimeAgentOutputObservation>,
  nowMs: number,
): ProjectedTaskState => {
  const scoped = outputAfterCursor(task, observations)
  const text = scoped.map(textDelta).join("")
  const latest = scoped[scoped.length - 1]
  const latestPermission = [...scoped].reverse().find(observation =>
    observation._tag === "PermissionRequest")
  const terminal = scoped.find(observation =>
    observation._tag === "TurnComplete" ||
      observation._tag === "Terminated" ||
      observation._tag === "Error")
  const status = terminal?._tag === "Error"
    ? "failed"
    : terminal === undefined && latestPermission !== undefined &&
        (latest === undefined || latest.sequence === latestPermission.sequence)
    ? "input_required"
    : terminal === undefined
    ? "working"
    : "completed"
  const expired = nowMs > task.spec.createdAtMs + task.spec.ttlMs && status !== "completed"
  const finalStatus = expired ? "failed" : status
  const markerObserved =
    task.spec.promptMarker === undefined ? text.length > 0 : text.includes(task.spec.promptMarker)
  const permissionRoundtripCompleted =
    latestPermission !== undefined &&
    (terminal !== undefined || scoped.some(observation =>
      observation.sequence > latestPermission.sequence &&
      observation._tag !== "Status"))
  const inputRequest = latestPermission === undefined
    ? undefined
    : inputRequestFromPermission(task.taskId, latestPermission)

  return {
    task,
    status: finalStatus,
    statusMessage: expired
      ? "task ttl expired"
      : finalStatus === "input_required"
      ? "permission request projected from runtime output"
      : finalStatus === "completed"
      ? "terminal output projected from runtime output"
      : finalStatus === "failed"
      ? "runtime output projected failure"
      : "task still waiting on runtime output",
    observations: scoped,
    text,
    ...(inputRequest === undefined
      ? {}
      : { inputRequest }),
    permissionRequestId: latestPermission?.permissionRequestId,
    markerObserved,
    permissionRoundtripCompleted,
  }
}

const taskObject = (state: ProjectedTaskState) => ({
  taskId: state.task.taskId,
  status: state.status,
  statusMessage: state.statusMessage,
  createdAtMs: state.task.spec.createdAtMs,
  ttl: state.task.spec.ttlMs,
  pollInterval: 500,
  ...(state.inputRequest === undefined ? {} : { inputRequest: state.inputRequest }),
  _meta: {
    "firegrid/projection-source": "runtime-output",
    "firegrid/session-id": state.task.spec.sessionId,
    "firegrid/after-sequence": state.task.spec.afterSequence,
  },
})

const callToolResultFromState = (state: ProjectedTaskState) => ({
  content: [{ type: "text", text: state.text }],
  structuredContent: {
    sessionId: state.task.spec.sessionId,
    inputId: state.task.spec.inputId,
    outputCount: state.observations.length,
    outputTags: state.observations.map(observation => observation._tag),
    markerObserved: state.markerObserved,
    permissionRoundtripCompleted: state.permissionRoundtripCompleted,
    projectedFrom: "runtime-output",
  },
  isError: state.status === "failed",
  _meta: relatedTaskMeta(state.task.taskId),
})

const permissionDecisionFromUpdate = (payload: unknown) => {
  const record = parseRecord(payload)
  const input = typeof record.input === "object" && record.input !== null
    ? record.input as Record<string, unknown>
    : record
  const decision = input.decision
  if (typeof decision === "object" && decision !== null && "_tag" in decision) {
    const tagged = decision as { readonly _tag?: unknown; readonly optionId?: unknown; readonly reason?: unknown }
    if (tagged._tag === "Allow") {
      return {
        _tag: "Allow" as const,
        ...(typeof tagged.optionId === "string" ? { optionId: tagged.optionId } : {}),
      }
    }
    if (tagged._tag === "Deny") {
      return {
        _tag: "Deny" as const,
        ...(typeof tagged.reason === "string" ? { reason: tagged.reason } : {}),
      }
    }
    if (tagged._tag === "Cancelled") {
      return { _tag: "Cancelled" as const }
    }
  }
  return { _tag: "Allow" as const }
}

const waitForProjectedTerminal = (
  runtime: ProjectionRuntime,
  task: ProjectedTask,
): Effect.Effect<ProjectedTaskState, unknown> =>
  Effect.gen(function*() {
    const initial = yield* runtime.outputSnapshot(task.spec.sessionId)
    const initialState = projectTaskState(
      task,
      initial,
      yield* Clock.currentTimeMillis,
    )
    if (initialState.status === "completed" || initialState.status === "failed") {
      return initialState
    }
    yield* runtime.outputStream(task.spec.sessionId).pipe(
      Stream.filter(observation => observation.sequence > task.spec.afterSequence),
      Stream.runForEachWhile(observation =>
        Effect.succeed(
          observation._tag !== "TurnComplete" &&
            observation._tag !== "Terminated" &&
            observation._tag !== "Error",
        )),
    )
    const observations = yield* runtime.outputSnapshot(task.spec.sessionId)
    const nowMs = yield* Clock.currentTimeMillis
    return projectTaskState(task, observations, nowMs)
  })

const buildProjectedTask = (
  args: Record<string, unknown>,
  nowMs: number,
  afterSequence: number,
  ttlMs: number,
): Effect.Effect<ProjectedTask, Error> =>
  Effect.sync(() => {
    const sessionId = typeof args.sessionId === "string" ? args.sessionId : ""
    if (sessionId.length === 0) throw new Error("session_prompt task requires sessionId")
    const inputId = typeof args.inputId === "string" && args.inputId.length > 0
      ? args.inputId
      : `mcp-task:${globalThis.crypto.randomUUID()}`
    const prompt = typeof args.prompt === "string" ? args.prompt : undefined
    const marker = prompt?.includes("MCP_TASK_PROJECTION_DONE")
      ? "MCP_TASK_PROJECTION_DONE"
      : undefined
    const spec: ProjectedSessionPromptTask = {
      v: 1,
      op: "session_prompt",
      sessionId,
      inputId,
      afterSequence,
      createdAtMs: nowMs,
      ttlMs,
      promptMarker: marker,
    }
    return { taskId: encodeTaskId(spec), spec }
  })

const snapshotState = (
  runtime: ProjectionRuntime,
  taskId: string,
): Effect.Effect<ProjectedTaskState, unknown> =>
  Effect.gen(function*() {
    const task = yield* decodeTaskId(taskId).pipe(
      Option.match({
        onNone: () => Effect.fail(new Error(`task id is not a projected Firegrid task: ${taskId}`)),
        onSome: Effect.succeed,
      }),
    )
    const observations = yield* runtime.outputSnapshot(task.spec.sessionId)
    const nowMs = yield* Clock.currentTimeMillis
    return projectTaskState(task, observations, nowMs)
  })

const makeTaskProtocol = (
  options: McpTaskProjectionWireOptions,
  runtime: ProjectionRuntime,
) =>
  Effect.gen(function*() {
    yield* Effect.logInfo("mcp task projection durable-streams protocol starting")
    const requestTags = yield* Ref.make(new Map<string, string>())
    const projectedRequests = yield* Ref.make(new Set<string>())
    const clientIds = new Set<number>([1])
    const disconnects = yield* Mailbox.make<number>()

    const sendToClient = (clientId: number, response: RpcMessage.FromServerEncoded) =>
      responseStream(options).append({ clientId, message: response } satisfies WireRpcMessage).pipe(
        Effect.asVoid,
        Effect.provide(FetchHttpClient.layer),
        Effect.orDie,
      )

    return yield* RpcServer.Protocol.make((writeRequest) =>
      Effect.gen(function*() {
        const handleRequest = (
          clientId: number,
          message: RpcMessage.FromClientEncoded,
        ): Effect.Effect<void, unknown> =>
          Effect.gen(function*() {
            if (message._tag !== "Request") {
              yield* writeRequest(clientId, message)
              return
            }
            const request = message
            yield* Ref.update(requestTags, map => new Map(map).set(request.id, request.tag))

            if (request.tag === "tools/call" && taskFromPayload(toolsCallPayload(request)) !== undefined) {
              const payload = toolsCallPayload(request)
              if (payload.name !== "session_prompt") {
                yield* writeRequest(clientId, request)
                return
              }
              const taskOptions = taskFromPayload(payload)
              const args = toolArguments(payload)
              const ttlMs = typeof taskOptions?.ttl === "number" ? taskOptions.ttl : 120_000
              const sessionId = typeof args.sessionId === "string" ? args.sessionId : ""
              const observations = sessionId.length === 0
                ? []
                : yield* runtime.outputSnapshot(sessionId)
              const afterSequence = observations.reduce(
                (max, observation) => Math.max(max, observation.sequence),
                -1,
              )
              const nowMs = yield* Clock.currentTimeMillis
              const task = yield* buildProjectedTask(args, nowMs, afterSequence, ttlMs)
              const working = projectTaskState(task, [], nowMs)
              yield* sendToClient(clientId, successResponse(request.id, {
                task: taskObject(working),
                _meta: {
                  "io.modelcontextprotocol/model-immediate-response":
                    `Firegrid projected task ${task.taskId} is working.`,
                  "firegrid/projection-source": "runtime-output",
                },
              }))
              const forwardedPayload: Record<string, unknown> = {
                ...payload,
                arguments: {
                  ...args,
                  inputId: task.spec.inputId,
                },
              }
              delete forwardedPayload.task
              yield* Ref.update(projectedRequests, set => new Set(set).add(request.id))
              yield* Effect.annotateCurrentSpan({
                "firegrid.mcp_task_projection.task_id": task.taskId,
                "firegrid.mcp_task_projection.session_id": task.spec.sessionId,
                "firegrid.mcp_task_projection.input_id": task.spec.inputId,
                "firegrid.mcp_task_projection.after_sequence": task.spec.afterSequence,
                "firegrid.mcp_task_projection.store": "none",
              })
              yield* Effect.forkDaemon(writeRequest(clientId, {
                ...request,
                payload: forwardedPayload,
              }))
              yield* runtime.restartIngress
              return
            }

            if (request.tag === "tasks/get") {
              const payload = toolsCallPayload(request)
              const taskId = typeof payload.taskId === "string" ? payload.taskId : ""
              const state = yield* snapshotState(runtime, taskId)
              yield* sendToClient(clientId, successResponse(request.id, taskObject(state)))
              return
            }

            if (request.tag === "tasks/result") {
              const payload = toolsCallPayload(request)
              const taskId = typeof payload.taskId === "string" ? payload.taskId : ""
              const task = yield* decodeTaskId(taskId).pipe(
                Option.match({
                  onNone: () => Effect.fail(new Error(`task id is not a projected Firegrid task: ${taskId}`)),
                  onSome: Effect.succeed,
                }),
              )
              const state = yield* waitForProjectedTerminal(runtime, task).pipe(
                Effect.timeoutFail({
                  duration: Duration.minutes(5),
                  onTimeout: () => new Error(`projected task ${taskId} did not reach terminal output`),
                }),
              )
              yield* sendToClient(clientId, successResponse(request.id, callToolResultFromState(state)))
              return
            }

            if (request.tag === "tasks/update") {
              const payload = toolsCallPayload(request)
              const taskId = typeof payload.taskId === "string" ? payload.taskId : ""
              const state = yield* snapshotState(runtime, taskId)
              if (state.permissionRequestId !== undefined) {
                yield* runtime.permissionRespondAppend({
                  contextId: state.task.spec.sessionId,
                  permissionRequestId: state.permissionRequestId,
                  decision: permissionDecisionFromUpdate(payload),
                  idempotencyKey: `mcp-task-projection:${taskId}:${state.permissionRequestId}`,
                })
              }
              yield* sendToClient(clientId, successResponse(request.id, {
                taskId,
                accepted: state.permissionRequestId !== undefined,
                projectedFrom: "runtime-output",
              }))
              return
            }

            yield* writeRequest(clientId, request)
          })

        yield* readRequestMessages(options).pipe(
          Stream.runForEach(event =>
            handleRequest(event.clientId, event.message as RpcMessage.FromClientEncoded).pipe(
              Effect.catchAllCause(cause =>
                Effect.logError(`mcp task projection protocol request failed: ${cause.toString()}`)),
            )),
          Effect.forkScoped,
        )

        return {
          disconnects,
          send: (clientId: number, response: RpcMessage.FromServerEncoded) =>
            Effect.gen(function*() {
              if (response._tag === "Exit" && (yield* Ref.get(projectedRequests)).has(response.requestId)) {
                return
              }
              const tag = response._tag === "Exit"
                ? (yield* Ref.get(requestTags)).get(response.requestId)
                : undefined
              yield* sendToClient(clientId, rewriteResult(tag, response))
            }).pipe(Effect.orDie),
          end: (_clientId: number) => Effect.void,
          clientIds: Effect.succeed(clientIds),
          initialMessage: Effect.succeed(Option.none()),
          supportsAck: false,
          supportsTransferables: false,
          supportsSpanPropagation: false,
        }
      }))
  })

export const makeMcpTaskProjectionProtocolLayer = (
  options: McpTaskProjectionWireOptions,
  runtime: ProjectionRuntime,
): Layer.Layer<RpcServer.Protocol> =>
  Layer.scoped(
    RpcServer.Protocol,
    makeTaskProtocol(options, runtime).pipe(Effect.orDie),
  )

export const runMcpServerLayer = McpServer.layer({
  name: "firegrid.task-projection-spike",
  version: "0.0.0",
})
