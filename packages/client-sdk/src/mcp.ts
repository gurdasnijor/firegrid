import type * as RpcMessage from "@effect/rpc/RpcMessage"
import type {
  PermissionDecision,
  SessionNewToolInput,
  SessionNewToolOutput,
  SessionPromptToolInput,
} from "@firegrid/protocol/agent-tools"
import type {
  RuntimeContext,
  RuntimeEventRow,
  RuntimeLogLineRow,
  RuntimeRunEventRow,
} from "@firegrid/protocol/launch"
import type {
  RuntimeAgentOutputObservation,
  SessionAgentOutputWaitInput,
  SessionAgentOutputWaitOutput,
  SessionPermissionRequestWaitInput,
  SessionPermissionRequestWaitOutput,
} from "@firegrid/protocol/session-facade"
import { Data, Duration, Effect, Option, Ref, Stream } from "effect"

export interface FiregridMcpClientOptions {
  readonly durableStreamsBaseUrl: string
  readonly namespace: string
  readonly streamId: string
  readonly clientId?: number
  readonly pollIntervalMs?: number
}

export interface FiregridMcpTask {
  readonly taskId: string
  readonly status: "working" | "input_required" | "completed" | "failed" | "cancelled"
  readonly statusMessage?: string
  readonly inputRequest?: unknown
}

export interface FiregridMcpTaskReader {
  readonly taskStates: (
    taskId: string,
  ) => Stream.Stream<FiregridMcpTask, FiregridMcpClientError>
  readonly taskResult: (
    taskId: string,
  ) => Effect.Effect<unknown, FiregridMcpClientError>
}

export interface FiregridMcpPermissionResponder {
  readonly respondToPermission: (
    taskId: string,
    decision: PermissionDecision,
  ) => Effect.Effect<unknown, FiregridMcpClientError>
}

export interface FiregridMcpRuntimeContextSnapshot {
  readonly contextId: string
  readonly context?: RuntimeContext
  readonly status?: RuntimeRunEventRow["status"]
  readonly runs: ReadonlyArray<RuntimeRunEventRow>
  readonly events: ReadonlyArray<RuntimeEventRow>
  readonly logs: ReadonlyArray<RuntimeLogLineRow>
  readonly agentOutputs: ReadonlyArray<RuntimeAgentOutputObservation>
}

export interface FiregridMcpObservationClient {
  readonly listContexts: Effect.Effect<ReadonlyArray<RuntimeContext>, FiregridMcpClientError>
  readonly watchContexts: (
    predicate?: (context: RuntimeContext) => boolean,
  ) => Stream.Stream<RuntimeContext, FiregridMcpClientError>
  readonly snapshot: (
    contextId: string,
  ) => Effect.Effect<FiregridMcpRuntimeContextSnapshot, FiregridMcpClientError>
  readonly waitForAgentOutput: (
    contextId: string,
    request?: SessionAgentOutputWaitInput,
  ) => Effect.Effect<SessionAgentOutputWaitOutput, FiregridMcpClientError>
  readonly waitForPermissionRequest: (
    contextId: string,
    request?: SessionPermissionRequestWaitInput,
  ) => Effect.Effect<SessionPermissionRequestWaitOutput, FiregridMcpClientError>
  readonly resourcesList: Effect.Effect<unknown, FiregridMcpClientError>
}

export interface FiregridMcpSessionWaitClient {
  readonly forAgentOutput: (
    request?: SessionAgentOutputWaitInput,
  ) => Effect.Effect<SessionAgentOutputWaitOutput, FiregridMcpClientError>
  readonly forPermissionRequest: (
    request?: SessionPermissionRequestWaitInput,
  ) => Effect.Effect<SessionPermissionRequestWaitOutput, FiregridMcpClientError>
}

export interface FiregridMcpSessionHandle
  extends FiregridMcpTaskReader, FiregridMcpPermissionResponder
{
  readonly sessionId: string
  readonly contextId: string
  readonly promptTask: (
    request: Omit<SessionPromptToolInput, "sessionId"> & {
      readonly taskTtlMs?: number
    },
  ) => Effect.Effect<FiregridMcpTask, FiregridMcpClientError>
  readonly snapshot: () => Effect.Effect<FiregridMcpRuntimeContextSnapshot, FiregridMcpClientError>
  readonly wait: FiregridMcpSessionWaitClient
}

export interface FiregridMcpClient extends FiregridMcpTaskReader {
  readonly initialize: Effect.Effect<unknown, FiregridMcpClientError>
  readonly toolsList: Effect.Effect<unknown, FiregridMcpClientError>
  readonly callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Effect.Effect<unknown, FiregridMcpClientError>
  readonly callToolTask: (
    name: string,
    args: Record<string, unknown>,
    options?: {
      readonly ttlMs?: number
    },
  ) => Effect.Effect<FiregridMcpTask, FiregridMcpClientError>
  readonly getTask: (
    taskId: string,
  ) => Effect.Effect<FiregridMcpTask, FiregridMcpClientError>
  readonly updateTask: (
    taskId: string,
    input: unknown,
  ) => Effect.Effect<unknown, FiregridMcpClientError>
  readonly sessions: {
    readonly createOrLoad: (
      request: SessionNewToolInput,
    ) => Effect.Effect<FiregridMcpSessionHandle, FiregridMcpClientError>
  }
  readonly observations: FiregridMcpObservationClient
}

export class FiregridMcpClientError extends Data.TaggedError("FiregridMcpClientError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

interface WireReadResult {
  readonly items: ReadonlyArray<unknown>
  readonly nextOffset: string
}

const clientError = (
  message: string,
  cause?: unknown,
): FiregridMcpClientError =>
  new FiregridMcpClientError({
    message,
    ...(cause === undefined ? {} : { cause }),
  })

const catchClientError = (cause: unknown): FiregridMcpClientError =>
  clientError(String(cause), cause)

const terminalTaskStatuses = new Set(["completed", "failed", "cancelled"])

const contextsResourceUri = "firegrid://runtime/contexts"

const contextSnapshotResourceUri = (contextId: string) =>
  `firegrid://runtime/contexts/${encodeURIComponent(contextId)}/snapshot`

const waitResourceUri = (
  contextId: string,
  kind: "agent-output" | "permission-request",
  request: SessionAgentOutputWaitInput = {},
) => {
  const uri = new URL(`firegrid://runtime/contexts/${encodeURIComponent(contextId)}/${kind}/wait`)
  if (request.afterSequence !== undefined) {
    uri.searchParams.set("afterSequence", String(request.afterSequence))
  }
  if (request.timeoutMs !== undefined) {
    uri.searchParams.set("timeoutMs", String(request.timeoutMs))
  }
  return uri.toString()
}

const streamName = (
  options: FiregridMcpClientOptions,
  suffix: "requests" | "responses",
) =>
  `${options.namespace}.firegrid.mcp.${options.streamId}.${suffix}`

const streamUrl = (
  options: FiregridMcpClientOptions,
  suffix: "requests" | "responses",
) => {
  const trimmed = options.durableStreamsBaseUrl.replace(/\/+$/, "")
  const separator = trimmed.includes("/v1/stream/") ? "/" : "/v1/stream/"
  return `${trimmed}${separator}${encodeURIComponent(streamName(options, suffix))}`
}

const createStream = (
  options: FiregridMcpClientOptions,
  suffix: "requests" | "responses",
): Effect.Effect<void, FiregridMcpClientError> =>
  Effect.tryPromise({
    try: async signal => {
      const response = await globalThis.fetch(
        streamUrl(options, suffix),
        {
          method: "PUT",
          headers: { "content-type": "application/json", connection: "close" },
          signal,
        },
      )
      await response.arrayBuffer()
    },
    catch: catchClientError,
  }).pipe(Effect.asVoid, Effect.catchAll(() => Effect.void))

const wireReadUrl = (
  options: FiregridMcpClientOptions,
  suffix: "responses",
  offset: string,
) => {
  const url = new URL(streamUrl(options, suffix))
  url.searchParams.set("offset", offset)
  url.searchParams.set("live", "long-poll")
  return url
}

const decodeReadBody = async (
  response: Response,
): Promise<ReadonlyArray<unknown>> => {
  const text = await response.text()
  if (text.trim().length === 0) return []
  const decoded: unknown = JSON.parse(text)
  return Array.isArray(decoded)
    ? decoded.map((item: unknown) => item)
    : [decoded]
}

const readResponseStreamBatch = async (
  url: URL,
  offset: string,
  signal: AbortSignal,
): Promise<WireReadResult> => {
  const response = await globalThis.fetch(url, {
    headers: { connection: "close" },
    signal,
  })
  if (![200, 204].includes(response.status)) {
    throw new Error(`read responses failed with status ${response.status}`)
  }
  const nextOffset = response.headers.get("stream-next-offset") ?? offset
  return {
    items: response.status === 204 ? [] : await decodeReadBody(response),
    nextOffset,
  }
}

const appendRequest = (
  options: FiregridMcpClientOptions,
  clientId: number,
  message: RpcMessage.FromClientEncoded,
): Effect.Effect<void, FiregridMcpClientError> =>
  Effect.tryPromise({
    try: async signal => {
      const response = await globalThis.fetch(streamUrl(options, "requests"), {
        method: "POST",
        headers: { "content-type": "application/json", connection: "close" },
        body: JSON.stringify({ clientId, message }),
        signal,
      })
      await response.arrayBuffer()
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`append request failed with status ${response.status}`)
      }
    },
    catch: catchClientError,
  })

const readWire = (
  options: FiregridMcpClientOptions,
  suffix: "responses",
  offset: string,
): Effect.Effect<WireReadResult, FiregridMcpClientError> =>
  Effect.tryPromise({
    try: signal => readResponseStreamBatch(wireReadUrl(options, suffix, offset), offset, signal),
    catch: catchClientError,
  })

const responseMessages = (
  options: FiregridMcpClientOptions,
  clientId: number,
): Stream.Stream<RpcMessage.FromServerEncoded, FiregridMcpClientError> =>
  Stream.unfoldEffect("-1", offset =>
    readWire(options, "responses", offset).pipe(
      Effect.map(result => Option.some([result.items, result.nextOffset] as const)),
    )).pipe(
      Stream.flatMap(items => Stream.fromIterable(items)),
      Stream.filter((event): event is { readonly clientId: number; readonly message: unknown } =>
        typeof event === "object" &&
        event !== null &&
        "clientId" in event &&
        event.clientId === clientId &&
        "message" in event),
      Stream.map(event => event.message as RpcMessage.FromServerEncoded),
    )

const exitValue = (
  response: RpcMessage.FromServerEncoded,
): Effect.Effect<unknown, FiregridMcpClientError> => {
  if (response._tag !== "Exit") {
    return Effect.fail(clientError(`unexpected MCP response tag ${response._tag}`))
  }
  if (response.exit._tag === "Success") return Effect.succeed(response.exit.value)
  return Effect.fail(clientError("MCP request failed", response.exit))
}

const taskFromValue = (
  value: unknown,
): Effect.Effect<FiregridMcpTask, FiregridMcpClientError> => {
  const record = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {}
  const task = typeof record.task === "object" && record.task !== null
    ? record.task as Record<string, unknown>
    : record
  const taskId = typeof task.taskId === "string" ? task.taskId : ""
  const status = typeof task.status === "string" ? task.status : ""
  if (taskId.length === 0 || !terminalTaskStatuses.has(status) && status !== "working" && status !== "input_required") {
    return Effect.fail(clientError("MCP task response did not include a valid task"))
  }
  return Effect.succeed({
    taskId,
    status: status as FiregridMcpTask["status"],
    ...(typeof task.statusMessage === "string" ? { statusMessage: task.statusMessage } : {}),
    ...(task.inputRequest === undefined ? {} : { inputRequest: task.inputRequest }),
  })
}

const toolOutputFromValue = (
  toolName: string,
  value: unknown,
): Effect.Effect<unknown, FiregridMcpClientError> => {
  const record = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined
  if (record?.isError === true) {
    return Effect.fail(clientError(`MCP tool ${toolName} returned an error`, record.structuredContent ?? value))
  }
  return record !== undefined && "structuredContent" in record
    ? Effect.succeed(record.structuredContent)
    : Effect.succeed(value)
}

const resourceJsonFromValue = <A>(
  value: unknown,
): Effect.Effect<A, FiregridMcpClientError> => {
  const record = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {}
  const contents: ReadonlyArray<unknown> = Array.isArray(record.contents)
    ? record.contents
    : []
  const first = contents.find((content): content is { readonly text: string } => {
    const candidate = typeof content === "object" && content !== null
      ? content as { readonly text?: unknown }
      : undefined
    return typeof candidate?.text === "string"
  })
  if (first === undefined) {
    return Effect.fail(clientError("MCP resource read did not include text content", value))
  }
  return Effect.try({
    try: () => JSON.parse(first.text) as A,
    catch: catchClientError,
  })
}

export const makeFiregridMcpClient = (
  options: FiregridMcpClientOptions,
): Effect.Effect<FiregridMcpClient, FiregridMcpClientError> =>
  Effect.gen(function*() {
    yield* Effect.all([
      createStream(options, "requests"),
      createStream(options, "responses"),
    ], { discard: true })

    const clientId = options.clientId ?? 1
    const pollIntervalMs = options.pollIntervalMs ?? 500
    const nextId = yield* Ref.make(0)
    const rpc = (
      tag: string,
      payload: unknown,
    ): Effect.Effect<unknown, FiregridMcpClientError> =>
      Effect.gen(function*() {
        const id = String(yield* Ref.updateAndGet(nextId, n => n + 1))
        yield* appendRequest(options, clientId, {
          _tag: "Request",
          id,
          tag,
          payload,
          headers: [],
        })
        const response = yield* responseMessages(options, clientId).pipe(
          Stream.filter(message =>
            message._tag === "Exit" &&
            message.requestId === id),
          Stream.runHead,
          Effect.timeoutFail({
            duration: Duration.seconds(90),
            onTimeout: () => clientError(`timed out waiting for ${tag}`),
          }),
          Effect.flatMap(Option.match({
            onNone: () => Effect.fail(clientError(`no response for ${tag}`)),
            onSome: Effect.succeed,
          })),
        )
        return yield* exitValue(response)
      }).pipe(
        Effect.withSpan(`firegrid.client.mcp.rpc.${tag}`, {
          kind: "client",
          attributes: {
            "firegrid.mcp.method": tag,
            "firegrid.mcp.stream_id": options.streamId,
          },
        }),
      )

    const initialize = rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "@firegrid/client-sdk/mcp", version: "0.0.0" },
    })
    const toolsList = rpc("tools/list", {})
    const callTool = (
      name: string,
      args: Record<string, unknown>,
    ) =>
      rpc("tools/call", { name, arguments: args }).pipe(
        Effect.flatMap(value => toolOutputFromValue(name, value)),
      )
    const callToolTask = (
      name: string,
      args: Record<string, unknown>,
      taskOptions?: {
        readonly ttlMs?: number
      },
    ) =>
      rpc("tools/call", {
        name,
        arguments: args,
        task: { ttl: taskOptions?.ttlMs ?? 120_000 },
      }).pipe(Effect.flatMap(taskFromValue))
    const getTask = (taskId: string) =>
      rpc("tasks/get", { taskId }).pipe(Effect.flatMap(taskFromValue))
    const taskStates = (taskId: string): Stream.Stream<FiregridMcpTask, FiregridMcpClientError> =>
      Stream.repeatEffect(getTask(taskId)).pipe(
        Stream.tap(() => Effect.sleep(Duration.millis(pollIntervalMs))),
      )
    const taskResult = (taskId: string) => rpc("tasks/result", { taskId })
    const updateTask = (taskId: string, input: unknown) =>
      rpc("tasks/update", { taskId, input })
    const respondToPermission = (taskId: string, decision: PermissionDecision) =>
      updateTask(taskId, { decision })
    const resourcesList = rpc("resources/list", {})
    const readResourceJson = <A>(
      uri: string,
    ): Effect.Effect<A, FiregridMcpClientError> =>
      rpc("resources/read", { uri }).pipe(
        Effect.flatMap(resourceJsonFromValue<A>),
      )
    const listContexts = readResourceJson<ReadonlyArray<RuntimeContext>>(contextsResourceUri)
    const snapshot = (
      contextId: string,
    ) =>
      readResourceJson<FiregridMcpRuntimeContextSnapshot>(
        contextSnapshotResourceUri(contextId),
      )
    const waitForAgentOutput = (
      contextId: string,
      request?: SessionAgentOutputWaitInput,
    ) =>
      readResourceJson<SessionAgentOutputWaitOutput>(
        waitResourceUri(contextId, "agent-output", request),
      )
    const waitForPermissionRequest = (
      contextId: string,
      request?: SessionPermissionRequestWaitInput,
    ) =>
      readResourceJson<SessionPermissionRequestWaitOutput>(
        waitResourceUri(contextId, "permission-request", request),
      )
    const watchContexts = (
      predicate: (context: RuntimeContext) => boolean = () => true,
    ): Stream.Stream<RuntimeContext, FiregridMcpClientError> =>
      Stream.repeatEffect(listContexts).pipe(
        Stream.tap(() => Effect.sleep(Duration.millis(pollIntervalMs))),
        Stream.flatMap(contexts => Stream.fromIterable(contexts)),
        Stream.filter(predicate),
      )
    const observations: FiregridMcpObservationClient = {
      listContexts,
      watchContexts,
      snapshot,
      waitForAgentOutput,
      waitForPermissionRequest,
      resourcesList,
    }

    const makeSessionHandle = (
      output: SessionNewToolOutput,
    ): Effect.Effect<FiregridMcpSessionHandle, FiregridMcpClientError> =>
      Effect.gen(function*() {
        const lastAgentOutputSequence = yield* Ref.make<number | undefined>(undefined)
        const forAgentOutput = (
          request?: SessionAgentOutputWaitInput,
        ): Effect.Effect<SessionAgentOutputWaitOutput, FiregridMcpClientError> =>
          Effect.gen(function*() {
            const tracked = yield* Ref.get(lastAgentOutputSequence)
            const effective: SessionAgentOutputWaitInput | undefined =
              request?.afterSequence !== undefined || tracked === undefined
                ? request
                : { ...request, afterSequence: tracked }
            const result = yield* waitForAgentOutput(output.session.contextId, effective)
            if (result.matched) {
              yield* Ref.set(lastAgentOutputSequence, result.output.sequence)
            }
            return result
          })
        return {
          sessionId: output.session.sessionId,
          contextId: output.session.contextId,
          promptTask: request =>
            callToolTask("session_prompt", {
              sessionId: output.session.sessionId,
              prompt: request.prompt,
              ...(request.inputId === undefined ? {} : { inputId: request.inputId }),
              ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
            }, request.taskTtlMs === undefined ? undefined : { ttlMs: request.taskTtlMs }),
          taskStates,
          taskResult,
          respondToPermission,
          snapshot: () => snapshot(output.session.contextId),
          wait: {
            forAgentOutput,
            forPermissionRequest: request =>
              waitForPermissionRequest(output.session.contextId, request),
          },
        }
      })

    const createOrLoad = (
      request: SessionNewToolInput,
    ) =>
      callTool("session_new", {
        agentKind: request.agentKind,
        prompt: request.prompt,
        ...(request.options === undefined ? {} : { options: request.options }),
      }).pipe(
        Effect.flatMap(value => {
          const record = typeof value === "object" && value !== null
            ? value as SessionNewToolOutput
            : undefined
          return record?.session?.sessionId === undefined
            ? Effect.fail(clientError("session_new did not return a session handle"))
            : makeSessionHandle(record)
        }),
      )

    return {
      initialize,
      toolsList,
      callTool,
      callToolTask,
      getTask,
      taskStates,
      taskResult,
      updateTask,
      sessions: { createOrLoad },
      observations,
    }
  })
