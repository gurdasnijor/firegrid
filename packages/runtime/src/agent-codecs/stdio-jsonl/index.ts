import { Effect, Stream } from "effect"
import type {
  AgentByteStream,
  AgentCapabilities,
  AgentCodec,
  AgentCodecOpenOptions,
  AgentInputEvent,
  AgentOutputEvent,
  StopReason,
} from "../../agent-io/index.ts"
import { AgentCodecError } from "../../agent-io/index.ts"

const codec = "stdio-jsonl"
const encoder = new TextEncoder()

export const StdioJsonlCapabilities: AgentCapabilities = {
  streamingText: true,
  tools: true,
  permissions: false,
  images: false,
  structuredInput: true,
  cancellation: false,
  multiTurn: true,
  customStatus: [],
}

const codecError = (
  op: string,
  message: string,
  cause?: unknown,
): AgentCodecError =>
  new AgentCodecError({
    codec,
    op,
    message,
    ...(cause === undefined ? {} : { cause }),
  })

const recoverableError = (
  message: string,
  cause?: unknown,
): AgentOutputEvent => ({
  _tag: "Error",
  cause: cause === undefined ? { message } : { message, cause },
  recoverable: true,
})

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined

const isStopReason = (value: unknown): value is StopReason =>
  value === "end_turn" ||
  value === "tool_use" ||
  value === "cancelled" ||
  value === "max_tokens" ||
  value === "error"

const optionalString = (
  record: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

const decodeTextChunk = (
  record: Record<string, unknown>,
): AgentOutputEvent => {
  const text = record["text"]
  if (typeof text !== "string") {
    return recoverableError("stdio-jsonl text event requires string text", record)
  }
  return {
    _tag: "TextChunk",
    text,
    messageId: optionalString(record, "messageId") ?? "stdio-jsonl",
  }
}

const decodeToolUse = (
  record: Record<string, unknown>,
): AgentOutputEvent => {
  const toolUseId = record["toolUseId"]
  const name = record["name"]
  if (typeof toolUseId !== "string" || typeof name !== "string") {
    return recoverableError(
      "stdio-jsonl tool_use event requires string toolUseId and name",
      record,
    )
  }
  return {
    _tag: "ToolUse",
    toolUseId,
    name,
    input: record["input"],
  }
}

const decodeTurnComplete = (
  record: Record<string, unknown>,
): AgentOutputEvent => {
  const rawStopReason = record["stopReason"] ?? "end_turn"
  if (!isStopReason(rawStopReason)) {
    return recoverableError(
      "stdio-jsonl turn_complete event has unsupported stopReason",
      record,
    )
  }
  const messageId = optionalString(record, "messageId")
  return {
    _tag: "TurnComplete",
    stopReason: rawStopReason,
    ...(messageId === undefined ? {} : { messageId }),
  }
}

const decodeStatus = (
  record: Record<string, unknown>,
): AgentOutputEvent => {
  const kind = optionalString(record, "kind") ?? optionalString(record, "status") ?? "status"
  const payload = record["payload"]
  return {
    _tag: "Status",
    kind,
    ...(payload === undefined ? {} : { payload }),
  }
}

const decodeStdoutLine = (line: string): AgentOutputEvent => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return recoverableError("empty stdio-jsonl line")

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed) as unknown
  } catch (cause) {
    return recoverableError("malformed stdio-jsonl JSON line", { line, cause })
  }

  const record = asRecord(parsed)
  if (record === undefined) {
    return recoverableError("stdio-jsonl line must decode to an object", parsed)
  }

  switch (record["type"]) {
    case "text":
    case "assistant":
      return decodeTextChunk(record)
    case "tool_use":
      return decodeToolUse(record)
    case "turn_complete":
    case "end_turn":
      return decodeTurnComplete(record)
    case "status":
      return decodeStatus(record)
    default:
      return recoverableError("unsupported stdio-jsonl event type", record)
  }
}

const encodePrompt = (
  event: Extract<AgentInputEvent, { _tag: "Prompt" }>,
) => ({
  type: "prompt" as const,
  correlationId: event.correlationId,
  content: event.content,
})

const encodeToolResult = (
  event: Extract<AgentInputEvent, { _tag: "ToolResult" }>,
) => ({
  type: "tool_result" as const,
  toolUseId: event.toolUseId,
  content: event.content,
  isError: event.isError,
})

const encodeInputEvent = (
  event: AgentInputEvent,
): Effect.Effect<unknown, AgentCodecError> => {
  switch (event._tag) {
    case "Prompt":
      return Effect.succeed(encodePrompt(event))
    case "ToolResult":
      return Effect.succeed(encodeToolResult(event))
    case "PermissionResponse":
    case "Cancel":
    case "Terminate":
      return Effect.fail(
        codecError("send", `stdio-jsonl does not support ${event._tag} input`),
      )
  }
}

const writeJsonLine = (
  stdin: WritableStream<Uint8Array>,
  event: AgentInputEvent,
): Effect.Effect<void, AgentCodecError> =>
  Effect.gen(function* () {
    const encoded = yield* encodeInputEvent(event)
    const line = yield* Effect.try({
      try: () => `${JSON.stringify(encoded)}\n`,
      catch: cause =>
        codecError("send", "failed to encode stdio-jsonl input", cause),
    })
    yield* Effect.acquireUseRelease(
      Effect.sync(() => stdin.getWriter()),
      writer =>
        Effect.tryPromise({
          try: () => writer.write(encoder.encode(line)),
          catch: cause =>
            codecError("send", "failed to write stdio-jsonl input", cause),
        }),
      writer => Effect.sync(() => writer.releaseLock()),
    )
  })

const stdoutEvents = (
  stdout: ReadableStream<Uint8Array>,
): Stream.Stream<AgentOutputEvent, AgentCodecError> =>
  Stream.fromReadableStream({
    evaluate: () => stdout,
    onError: cause =>
      codecError("stdout", "failed reading stdio-jsonl stdout", cause),
    releaseLockOnEnd: true,
  }).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.map(decodeStdoutLine),
  )

const terminatedEvent = (
  bytes: AgentByteStream,
): Stream.Stream<AgentOutputEvent, AgentCodecError> =>
  Stream.fromEffect(
    bytes.exit.pipe(
      Effect.map(exit => ({
        _tag: "Terminated" as const,
        ...(exit.exitCode === undefined ? {} : { exitCode: exit.exitCode }),
      })),
      Effect.mapError(cause =>
        codecError("exit", "failed waiting for stdio-jsonl process exit", cause,),
      ),
    ),
  )

const outputs = (
  bytes: AgentByteStream,
): Stream.Stream<AgentOutputEvent, AgentCodecError> =>
  Stream.succeed<AgentOutputEvent>({
    _tag: "Ready",
    capabilities: StdioJsonlCapabilities,
  }).pipe(
    Stream.concat(
      stdoutEvents(bytes.stdout).pipe(Stream.merge(terminatedEvent(bytes))),
    ),
  )

export const StdioJsonlCodec: AgentCodec = {
  kind: codec,
  capabilities: StdioJsonlCapabilities,
  open: (
    bytes: AgentByteStream,
    _options: AgentCodecOpenOptions,
  ) =>
    Effect.succeed({
      send: event => writeJsonLine(bytes.stdin, event),
      outputs: outputs(bytes),
    }),
}
