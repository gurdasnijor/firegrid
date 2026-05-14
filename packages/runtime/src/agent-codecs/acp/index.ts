import * as acp from "@agentclientprotocol/sdk"
import { Effect, Queue, Stream } from "effect"
import type {
  AgentByteStream,
  AgentCapabilities,
  AgentCodec,
  AgentInputEvent,
  AgentOutputEvent,
  PermissionDecision,
  PermissionOption,
  StopReason,
} from "../../agent-io/index.ts"
import { AgentCodecError } from "../../agent-io/index.ts"

const codec = "acp"

export const AcpCapabilities: AgentCapabilities = {
  streamingText: true,
  tools: true,
  permissions: true,
  images: false,
  structuredInput: false,
  cancellation: true,
  multiTurn: true,
  customStatus: ["tool_call_update"],
}

const codecError = (op: string, message: string, cause?: unknown): AgentCodecError => {
  const details = cause === undefined ? {} : { cause }
  return new AgentCodecError({
    codec,
    op,
    message,
    ...details,
  })
}

const recoverableError = (message: string, cause?: unknown): AgentOutputEvent => {
  const eventCause = cause === undefined ? { message } : { message, cause }
  return {
    _tag: "Error",
    cause: eventCause,
    recoverable: true,
  }
}

const mapStopReason = (stopReason: acp.StopReason): StopReason => {
  switch (stopReason) {
    case "end_turn":
    case "cancelled":
    case "max_tokens":
      return stopReason
    case "max_turn_requests":
      return "max_tokens"
    case "refusal":
      return "error"
  }
}

const mapPromptContent = (
  event: Extract<AgentInputEvent, { _tag: "Prompt" }>,
): Effect.Effect<Array<acp.ContentBlock>, AgentCodecError> =>
  Effect.forEach(event.content, part => {
    switch (part._tag) {
      case "Text":
        return Effect.succeed<acp.ContentBlock>({
          type: "text",
          text: part.text,
        })
      case "Image":
      case "Structured":
        return Effect.fail(
          codecError("send", `ACP codec does not support ${part._tag} prompt parts`),
        )
    }
  })

const mapPermissionOptions = (
  options: ReadonlyArray<acp.PermissionOption>,
): Array<PermissionOption> =>
  options.map(option => ({
    optionId: option.optionId,
    kind: option.kind,
    name: option.name,
  }))

const selectedOptionId = (
  decision: PermissionDecision,
  options: ReadonlyArray<acp.PermissionOption>,
): string | undefined => {
  switch (decision._tag) {
    case "Allow":
      return decision.optionId ??
        options.find(option => option.kind === "allow_once" || option.kind === "allow_always")
          ?.optionId
    case "Deny":
      return options.find(option => option.kind === "reject_once" || option.kind === "reject_always")
        ?.optionId
    case "Cancelled":
      return undefined
  }
}

const permissionResponse = (
  decision: PermissionDecision,
  options: ReadonlyArray<acp.PermissionOption>,
): acp.RequestPermissionResponse => {
  const optionId = selectedOptionId(decision, options)
  if (optionId === undefined) {
    return { outcome: { outcome: "cancelled" } }
  }
  return { outcome: { outcome: "selected", optionId } }
}

const status = (
  kind: string,
  payload?: unknown,
): AgentOutputEvent => ({
  _tag: "Status",
  kind,
  ...(payload === undefined ? {} : { payload }),
})

const mapSessionUpdate = (
  params: acp.SessionNotification,
): ReadonlyArray<AgentOutputEvent> => {
  const update = params.update
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const content = update.content
      if (content.type !== "text") {
        return [status("agent_message_chunk", update)]
      }
      return [{
        _tag: "TextChunk",
        text: content.text,
        messageId: update.messageId ?? params.sessionId,
      }]
    }
    case "tool_call":
      return [{
        _tag: "ToolUse",
        toolUseId: update.toolCallId,
        name: update.title,
        input: update.rawInput,
      }]
    case "tool_call_update":
      return [status("tool_call_update", update)]
    default:
      return [status(update.sessionUpdate, update)]
  }
}

const terminatedEvent = (
  bytes: AgentByteStream,
): Stream.Stream<AgentOutputEvent, AgentCodecError> =>
  bytes.exit.pipe(
    Effect.map(exit => {
      const maybeCode = exit.exitCode === undefined ? {} : { exitCode: exit.exitCode }
      return {
        _tag: "Terminated" as const,
        ...maybeCode,
      }
    }),
    Effect.mapError(cause =>
      codecError("exit", "failed waiting for ACP process exit", cause),
    ),
    Stream.fromEffect,
  )

export const AcpCodec: AgentCodec = {
  kind: codec,
  capabilities: AcpCapabilities,
  open: bytes =>
    Effect.gen(function*() {
      const outputEvents = yield* Queue.unbounded<AgentOutputEvent>()
      const emit = (event: AgentOutputEvent): Promise<void> =>
        Effect.runPromise(Queue.offer(outputEvents, event)).then(() => undefined)

      const pendingPermissions = new Map<
        string,
        {
          readonly options: ReadonlyArray<acp.PermissionOption>
          readonly resolve: (response: acp.RequestPermissionResponse) => void
        }
      >()
      let permissionCounter = 0
      let sessionId = ""

      const cancelPendingPermissions = () => {
        for (const { resolve } of pendingPermissions.values()) {
          resolve({ outcome: { outcome: "cancelled" } })
        }
        pendingPermissions.clear()
      }

      const client: acp.Client = {
        requestPermission: async params => {
          const permissionRequestId = `permission-${++permissionCounter}`
          await emit({
            _tag: "PermissionRequest",
            permissionRequestId,
            toolUseId: params.toolCall.toolCallId,
            options: mapPermissionOptions(params.options),
          })
          return await new Promise<acp.RequestPermissionResponse>(resolve => {
            pendingPermissions.set(permissionRequestId, {
              options: params.options,
              resolve,
            })
          })
        },
        sessionUpdate: async params => {
          for (const event of mapSessionUpdate(params)) {
            await emit(event)
          }
        },
      }

      const stream = acp.ndJsonStream(bytes.stdin, bytes.stdout)
      const connection = new acp.ClientSideConnection(() => client, stream)

      yield* Effect.tryPromise({
        try: async () => {
          await connection.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          })
          const session = await connection.newSession({
            cwd: process.cwd(),
            mcpServers: [],
          })
          sessionId = session.sessionId
        },
        catch: cause =>
          codecError("open", "failed to initialize ACP session", cause),
      })

      const send = (event: AgentInputEvent): Effect.Effect<void, AgentCodecError> => {
        switch (event._tag) {
          case "Prompt":
            return mapPromptContent(event).pipe(
              Effect.flatMap(prompt =>
                Effect.sync(() => {
                  void connection.prompt({
                    sessionId,
                    messageId: event.correlationId,
                    prompt,
                  }).then(response =>
                    emit({
                      _tag: "TurnComplete",
                      stopReason: mapStopReason(response.stopReason),
                      ...(response.userMessageId === undefined || response.userMessageId === null
                        ? {}
                        : { messageId: response.userMessageId }),
                    }),
                  ).catch(cause =>
                    emit(recoverableError("ACP prompt failed", cause)),
                  )
                }),
              ),
            )
          case "PermissionResponse": {
            const pending = pendingPermissions.get(event.permissionRequestId)
            if (pending === undefined) {
              return Effect.fail(
                codecError(
                  "send",
                  `unknown ACP permission request ${event.permissionRequestId}`,
                ),
              )
            }
            pendingPermissions.delete(event.permissionRequestId)
            return Effect.sync(() => {
              pending.resolve(permissionResponse(event.decision, pending.options))
            })
          }
          case "Cancel":
            return Effect.tryPromise({
              try: async () => {
                cancelPendingPermissions()
                await connection.cancel({ sessionId })
              },
              catch: cause => codecError("send", "failed to cancel ACP session", cause),
            })
          case "Terminate":
            return Effect.tryPromise({
              try: async () => {
                const writer = bytes.stdin.getWriter()
                try {
                  await writer.close()
                } finally {
                  writer.releaseLock()
                }
              },
              catch: cause =>
                codecError("send", "failed to terminate ACP byte stream", cause),
            })
          case "ToolResult":
            return Effect.fail(
              codecError(
                "send",
                "ACP ToolResult input is out-of-band for this codec slice",
              ),
            )
        }
      }

      const outputs = Stream.succeed<AgentOutputEvent>({
        _tag: "Ready",
        capabilities: AcpCapabilities,
      }).pipe(
        Stream.concat(
          Stream.fromQueue(outputEvents).pipe(
            Stream.merge(terminatedEvent(bytes)),
          ),
        ),
      )

      return { send, outputs }
    }),
}
