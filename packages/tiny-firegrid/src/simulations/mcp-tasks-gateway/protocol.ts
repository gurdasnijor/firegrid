import { FetchHttpClient } from "@effect/platform"
import { McpServer } from "@effect/ai"
import { RpcServer } from "@effect/rpc"
import type * as RpcMessage from "@effect/rpc/RpcMessage"
import { Duration, Effect, Fiber, Layer, Mailbox, Option, Ref, Stream } from "effect"
import {
  appendTaskEvent,
  responseStream,
  readRequestMessages,
  taskEvents,
  type McpTasksWireOptions,
  type TaskEvent,
  type WireRpcMessage,
} from "./wire.ts"

type TaskStatus = TaskEvent["status"]

interface RuntimeAgentOutputObservation {
  readonly event: { readonly _tag: string } & Record<string, unknown>
}

interface PermissionRespondInput {
  readonly contextId: string
  readonly permissionRequestId: string
  readonly decision: unknown
  readonly idempotencyKey: string
}

type PermissionRespondAppend = (
  input: PermissionRespondInput,
) => Effect.Effect<unknown, unknown>

interface ActiveTask {
  readonly taskId: string
  readonly clientId: number
  readonly requestId: string
  readonly createdAt: string
  readonly ttl: number
  readonly pollInterval: number
  readonly toolName: string
  readonly sessionId: string | undefined
  readonly promptText: string | undefined
}

interface AwaitingInput {
  readonly taskId: string
  readonly sessionId: string
  readonly permissionRequestId: string
}

interface TaskRuntime {
  readonly activeByRequestId: Ref.Ref<Map<string, ActiveTask>>
  readonly activeByTaskId: Ref.Ref<Map<string, ActiveTask>>
  readonly inputWaiters: Ref.Ref<Map<string, AwaitingInput>>
  readonly taskFibers: Ref.Ref<Map<string, Fiber.RuntimeFiber<unknown, unknown>>>
}

// effect-quality-allow-wall-clock
const nowIso = (): string => new Date().toISOString()

const taskObject = (event: TaskEvent) => ({
  taskId: event.taskId,
  status: event.status,
  ...(event.statusMessage === undefined ? {} : { statusMessage: event.statusMessage }),
  createdAt: event.createdAt,
  lastUpdatedAt: event.lastUpdatedAt,
  ttl: event.ttl,
  pollInterval: event.pollInterval,
  ...(event.inputRequest === undefined ? {} : { inputRequest: event.inputRequest }),
})

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

const taskEvent = (
  active: ActiveTask,
  status: TaskStatus,
  patch: {
    readonly statusMessage?: string
    readonly result?: unknown
    readonly inputRequest?: unknown
  } = {},
): TaskEvent => ({
  taskId: active.taskId,
  status,
  ...(patch.statusMessage === undefined ? {} : { statusMessage: patch.statusMessage }),
  createdAt: active.createdAt,
  lastUpdatedAt: nowIso(),
  ttl: active.ttl,
  pollInterval: active.pollInterval,
  ...(patch.result === undefined ? {} : { result: patch.result }),
  ...(patch.inputRequest === undefined ? {} : { inputRequest: patch.inputRequest }),
})

const latestTaskEvent = (
  options: McpTasksWireOptions,
  taskId: string,
): Effect.Effect<Option.Option<TaskEvent>, unknown> =>
  taskEvents(options).pipe(
    Stream.filter(event => event.taskId === taskId),
    Stream.runLast,
  )

const awaitTerminalTaskEvent = (
  options: McpTasksWireOptions,
  taskId: string,
): Effect.Effect<TaskEvent, unknown> =>
  taskEvents(options).pipe(
    Stream.filter(event =>
      event.taskId === taskId &&
      (event.status === "completed" ||
        event.status === "failed" ||
        event.status === "cancelled")),
    Stream.runHead,
    Effect.flatMap(Option.match({
      onNone: () => Effect.fail(new Error(`task ${taskId} did not reach terminal status`)),
      onSome: Effect.succeed,
    })),
  )

const appendStatus = (
  options: McpTasksWireOptions,
  active: ActiveTask,
  status: TaskStatus,
  patch?: {
    readonly statusMessage?: string
    readonly result?: unknown
    readonly inputRequest?: unknown
  },
) =>
  appendTaskEvent(options, taskEvent(active, status, patch)).pipe(
    Effect.tap(() =>
      Effect.annotateCurrentSpan({
        "firegrid.mcp_tasks.task_id": active.taskId,
        "firegrid.mcp_tasks.tool_name": active.toolName,
        "firegrid.mcp_tasks.status": status,
        "firegrid.mcp_tasks.session_id": active.sessionId ?? "",
      })),
  )

const callToolResultFromText = (
  taskId: string,
  text: string,
  data: Record<string, unknown>,
) => ({
  content: [{ type: "text", text }],
  structuredContent: data,
  isError: false,
  _meta: relatedTaskMeta(taskId),
})

const permissionDecisionFromUpdate = (payload: unknown) => {
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

const followPromptLifecycle = (
  options: McpTasksWireOptions,
  runtime: TaskRuntime,
  active: ActiveTask,
  outputStream: Stream.Stream<RuntimeAgentOutputObservation, unknown>,
): Effect.Effect<void, unknown> =>
  Effect.gen(function*() {
    let text = ""
    let outputCount = 0
    let terminalCount = 0
    let sawPermissionRequest = false
    const outputTags: Array<string> = []

    const observations = outputStream.pipe(Stream.take(80))
    yield* observations.pipe(
      Stream.runForEach(observation =>
	        Effect.gen(function*() {
	          outputCount += 1
	          outputTags.push(observation.event._tag)
	          if (observation.event._tag === "TextChunk") {
	            const part = typeof observation.event.part === "object" && observation.event.part !== null
	              ? observation.event.part as Record<string, unknown>
	              : {}
	            text += typeof part.delta === "string" ? part.delta : ""
	            yield* appendStatus(options, active, "working", {
	              statusMessage: `streamed text chunk ${outputCount}`,
	            })
	          }
          if (observation.event._tag === "Status") {
            yield* appendStatus(options, active, "working", {
              statusMessage: String(observation.event.payload ?? observation.event.kind),
            })
          }
	          if (observation.event._tag === "PermissionRequest") {
	            const request = observation.event
	            if (typeof request.permissionRequestId !== "string") return
	            const permissionRequestId = request.permissionRequestId
	            sawPermissionRequest = true
	            yield* Ref.update(runtime.inputWaiters, map =>
	              new Map(map).set(active.taskId, {
	                taskId: active.taskId,
	                sessionId: active.sessionId ?? "",
	                permissionRequestId,
	              }))
	            yield* appendStatus(options, active, "input_required", {
	              statusMessage: "permission request waiting for task input",
	              inputRequest: {
	                permissionRequestId,
                toolUseId: request.toolUseId,
                options: request.options,
                _meta: relatedTaskMeta(active.taskId),
              },
            })
          }
          if (observation.event._tag === "TurnComplete" || observation.event._tag === "Terminated") {
            terminalCount += 1
            const marker = active.promptText?.includes("MCP_TASKS_GATEWAY_DONE")
              ? "MCP_TASKS_GATEWAY_DONE"
              : undefined
            const markerObserved = marker === undefined ? text.length > 0 : text.includes(marker)
            if (
              observation.event._tag !== "Terminated" &&
              terminalCount === 1 &&
              !sawPermissionRequest &&
              !markerObserved
            ) {
              yield* appendStatus(options, active, "working", {
                statusMessage: "ignored earlier turn terminal before tasked prompt output",
              })
              return
            }
            const stillWaitingForInput = (yield* Ref.get(runtime.inputWaiters)).has(active.taskId)
            const result = callToolResultFromText(active.taskId, text, {
              sessionId: active.sessionId,
              outputCount,
              outputTags,
              permissionRoundtripCompleted: sawPermissionRequest && !stillWaitingForInput,
              markerObserved,
            })
            yield* appendStatus(options, active, "completed", {
              statusMessage: "prompt lifecycle reached terminal output",
              result,
            })
          }
        }),
      ),
    )
  }).pipe(
    Effect.withSpan("tiny_firegrid.mcp_tasks.follow_prompt_lifecycle", {
      attributes: {
        "firegrid.mcp_tasks.task_id": active.taskId,
        "firegrid.session.id": active.sessionId ?? "",
      },
    }),
  )

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
              cancel: true,
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

const terminalStatusForToolResult = (result: unknown): TaskStatus => {
  if (typeof result !== "object" || result === null) return "completed"
  const record = result as Record<string, unknown>
  return record.isError === true ? "failed" : "completed"
}

const makeTaskProtocol = (
  options: McpTasksWireOptions,
  contextOutput: (contextId: string) => Stream.Stream<RuntimeAgentOutputObservation, unknown>,
  permissionRespondAppend: PermissionRespondAppend,
) =>
  Effect.gen(function*() {
    yield* Effect.logInfo("mcp tasks durable-streams protocol starting")
    const activeByRequestId = yield* Ref.make(new Map<string, ActiveTask>())
    const activeByTaskId = yield* Ref.make(new Map<string, ActiveTask>())
    const inputWaiters = yield* Ref.make(new Map<string, AwaitingInput>())
    const taskFibers = yield* Ref.make(new Map<string, Fiber.RuntimeFiber<unknown, unknown>>())
    const requestTags = yield* Ref.make(new Map<string, string>())
    const clientIds = new Set<number>([1])
    const disconnects = yield* Mailbox.make<number>()
    const runtime: TaskRuntime = {
      activeByRequestId,
      activeByTaskId,
      inputWaiters,
      taskFibers,
    }

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
            const taskOptions = taskFromPayload(payload)
            const args = toolArguments(payload)
            const ttl = typeof taskOptions?.ttl === "number" ? taskOptions.ttl : 120_000
            const toolName = typeof payload.name === "string" ? payload.name : "<unknown>"
            const taskId = globalThis.crypto.randomUUID()
            const active: ActiveTask = {
              taskId,
              clientId,
              requestId: request.id,
              createdAt: nowIso(),
              ttl,
              pollInterval: 500,
              toolName,
              sessionId: typeof args.sessionId === "string" ? args.sessionId : undefined,
              promptText: typeof args.prompt === "string" ? args.prompt : undefined,
            }
            yield* Ref.update(activeByRequestId, map => new Map(map).set(request.id, active))
            yield* Ref.update(activeByTaskId, map => new Map(map).set(taskId, active))
            const event = taskEvent(active, "working", {
              statusMessage: "task accepted",
            })
            yield* appendTaskEvent(options, event)
            yield* sendToClient(clientId, successResponse(request.id, {
              task: taskObject(event),
              _meta: {
                "io.modelcontextprotocol/model-immediate-response":
                  `Firegrid task ${taskId} is working.`,
              },
            }))
            const forwardedPayload = { ...payload }
            delete forwardedPayload.task
            yield* Effect.forkDaemon(writeRequest(clientId, {
              ...request,
              payload: forwardedPayload,
            }))
            return
          }

          if (request.tag === "tasks/get") {
            const payload = toolsCallPayload(request)
            const taskId = typeof payload.taskId === "string" ? payload.taskId : ""
            const latest = yield* latestTaskEvent(options, taskId)
            const value = Option.match(latest, {
              onNone: () => ({
                taskId,
                status: "failed",
                statusMessage: "task not found",
                createdAt: nowIso(),
                lastUpdatedAt: nowIso(),
                ttl: 0,
                pollInterval: 500,
              }),
              onSome: taskObject,
            })
            yield* sendToClient(clientId, successResponse(request.id, value))
            return
          }

          if (request.tag === "tasks/result") {
            const payload = toolsCallPayload(request)
            const taskId = typeof payload.taskId === "string" ? payload.taskId : ""
	            const terminal = yield* awaitTerminalTaskEvent(options, taskId)
	            yield* sendToClient(clientId, successResponse(request.id, {
	              ...(typeof terminal.result === "object" && terminal.result !== null
	                ? terminal.result
	                : { content: [], isError: terminal.status !== "completed" }),
	              _meta: relatedTaskMeta(taskId),
	            }))
            return
          }

          if (request.tag === "tasks/update") {
            const payload = toolsCallPayload(request)
            const taskId = typeof payload.taskId === "string" ? payload.taskId : ""
            const waiter = (yield* Ref.get(inputWaiters)).get(taskId)
            const active = (yield* Ref.get(activeByTaskId)).get(taskId)
            if (waiter !== undefined && active !== undefined) {
              const decision = permissionDecisionFromUpdate(payload)
              yield* permissionRespondAppend({
                contextId: waiter.sessionId,
                permissionRequestId: waiter.permissionRequestId,
                decision,
                idempotencyKey: `mcp-task:${taskId}:${waiter.permissionRequestId}`,
              })
              yield* appendStatus(options, active, "working", {
                statusMessage: "permission input accepted",
              })
              yield* Ref.update(inputWaiters, map => {
                const next = new Map(map)
                next.delete(taskId)
                return next
              })
            }
            yield* sendToClient(clientId, successResponse(request.id, {
              taskId,
              accepted: waiter !== undefined,
            }))
            return
          }

          if (request.tag === "tasks/cancel") {
            const payload = toolsCallPayload(request)
            const taskId = typeof payload.taskId === "string" ? payload.taskId : ""
            const active = (yield* Ref.get(activeByTaskId)).get(taskId)
            const fiber = (yield* Ref.get(taskFibers)).get(taskId)
            if (fiber !== undefined) yield* Fiber.interrupt(fiber)
            if (active !== undefined) {
              yield* appendStatus(options, active, "cancelled", {
                statusMessage: "task cancelled",
              })
            }
            yield* sendToClient(clientId, successResponse(request.id, {
              taskId,
              cancelled: active !== undefined,
            }))
            return
          }

          yield* writeRequest(clientId, request)
        })

	      yield* readRequestMessages(options).pipe(
	        Stream.runForEach(event =>
	          handleRequest(event.clientId, event.message as RpcMessage.FromClientEncoded).pipe(
	            Effect.catchAllCause(cause =>
	              Effect.logError(`mcp tasks protocol request failed: ${cause.toString()}`)),
	          )),
	        Effect.forkScoped,
	      )

      return {
        disconnects,
        send: (clientId: number, response: RpcMessage.FromServerEncoded) =>
          Effect.gen(function*() {
            if (response._tag === "Exit") {
              const active = (yield* Ref.get(activeByRequestId)).get(response.requestId)
              if (active !== undefined && response.exit._tag === "Success") {
                const result = response.exit.value
                const status = terminalStatusForToolResult(result)
                if (active.toolName === "session_prompt" && active.sessionId !== undefined && status === "completed") {
                  const fiber = yield* followPromptLifecycle(
                    options,
                    runtime,
                    active,
                    contextOutput(active.sessionId),
	                  ).pipe(
	                    Effect.timeout(Duration.minutes(5)),
	                    Effect.catchAllCause(cause =>
	                      appendStatus(options, active, "failed", {
	                        statusMessage: `prompt lifecycle failed: ${cause.toString()}`,
	                        result: {
	                          content: [{ type: "text", text: cause.toString() }],
	                          isError: true,
	                          _meta: relatedTaskMeta(active.taskId),
	                        },
                      })),
                    Effect.forkDaemon,
                  )
                  yield* Ref.update(taskFibers, map => new Map(map).set(active.taskId, fiber))
                } else {
                  yield* appendStatus(options, active, status, {
                    statusMessage: status === "failed"
                      ? "tool result reported isError:true"
                      : "tool result completed",
	                    result: {
	                      ...(typeof result === "object" && result !== null
	                        ? result
	                        : { content: [], isError: false }),
	                      _meta: relatedTaskMeta(active.taskId),
	                    },
                  })
                }
                return
              }
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

export const makeMcpTasksProtocolLayer = (
  options: McpTasksWireOptions,
  contextOutput: (contextId: string) => Stream.Stream<RuntimeAgentOutputObservation, unknown>,
  permissionRespondAppend: PermissionRespondAppend,
): Layer.Layer<RpcServer.Protocol> =>
  Layer.scoped(
    RpcServer.Protocol,
    makeTaskProtocol(options, contextOutput, permissionRespondAppend).pipe(Effect.orDie),
  )

export const runMcpServerLayer = McpServer.layer({
  name: "firegrid.tasks-gateway-spike",
  version: "0.0.0",
})
