import { Prompt, Response } from "@effect/ai"
import { Effect, Layer, Match, Schema, Stream } from "effect"
import type {
  AgentCapabilities,
  AgentInputEvent,
  AgentOutputEvent,
  StopReason,
} from "../../events/index.ts"
import type { AgentByteStream } from "../../sources/byte-stream.ts"
import { AgentCodecError, AgentSession } from "../contract.ts"

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
  value === "stop" ||
  value === "length" ||
  value === "content-filter" ||
  value === "tool-calls" ||
  value === "error" ||
  value === "pause" ||
  value === "other" ||
  value === "unknown"

// Back-compat shim for early stdio-jsonl agents that emitted ACP/Firegrid
// stopReason strings before this codec moved to Effect AI FinishReason.
const FiregridLegacyStopReasonMap = {
  end_turn: "stop",
  tool_use: "tool-calls",
  cancelled: "other",
  max_tokens: "length",
} as const satisfies Record<string, StopReason>

const decodeFinishReason = (value: unknown): StopReason | undefined => {
  if (typeof value === "string" && value in FiregridLegacyStopReasonMap) {
    return FiregridLegacyStopReasonMap[value as keyof typeof FiregridLegacyStopReasonMap]
  }
  return isStopReason(value) ? value : undefined
}

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
    part: Response.textDeltaPart({
      id: optionalString(record, "messageId") ?? "stdio-jsonl",
      delta: text,
    }),
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
    part: Prompt.toolCallPart({
      id: toolUseId,
      name,
      params: record["input"],
      providerExecuted: false,
    }),
  }
}

const decodeTurnComplete = (
  record: Record<string, unknown>,
): AgentOutputEvent => {
  const finishReason = decodeFinishReason(
    record["finishReason"] ?? record["stopReason"] ?? "stop",
  )
  if (finishReason === undefined) {
    return recoverableError(
      "stdio-jsonl turn_complete event has unsupported finishReason",
      record,
    )
  }
  const messageId = optionalString(record, "messageId")
  return {
    _tag: "TurnComplete",
    finishReason,
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

  return Match.value(record["type"]).pipe(
    Match.when("text", () => decodeTextChunk(record)),
    Match.when("assistant", () => decodeTextChunk(record)),
    Match.when("tool_use", () => decodeToolUse(record)),
    Match.when("turn_complete", () => decodeTurnComplete(record)),
    Match.when("end_turn", () => decodeTurnComplete(record)),
    Match.when("status", () => decodeStatus(record)),
    Match.orElse(() => recoverableError("unsupported stdio-jsonl event type", record)),
  )
}

const encodePrompt = (
  event: Extract<AgentInputEvent, { _tag: "Prompt" }>,
) => ({
  type: "prompt" as const,
  correlationId: event.correlationId,
  prompt: Schema.encodeSync(Prompt.UserMessage)(event.prompt),
})

const encodeToolResult = (
  event: Extract<AgentInputEvent, { _tag: "ToolResult" }>,
) => ({
  type: "tool_result" as const,
  toolUseId: event.part.id,
  name: event.part.name,
  content: event.part.result,
  isError: event.part.isFailure,
})

const encodeInputEvent = (
  event: AgentInputEvent,
): Effect.Effect<unknown, AgentCodecError> => {
  return Match.value(event).pipe(
    Match.tag("Prompt", prompt => Effect.succeed(encodePrompt(prompt))),
    Match.tag("ToolResult", toolResult => Effect.succeed(encodeToolResult(toolResult))),
    Match.tag("PermissionResponse", unsupported =>
      Effect.fail(codecError("send", `stdio-jsonl does not support ${unsupported._tag} input`))),
    Match.tag("Cancel", unsupported =>
      Effect.fail(codecError("send", `stdio-jsonl does not support ${unsupported._tag} input`))),
    Match.tag("Terminate", unsupported =>
      Effect.fail(codecError("send", `stdio-jsonl does not support ${unsupported._tag} input`))),
    Match.exhaustive,
  )
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
    Stream.withSpan("firegrid.agent_event_pipeline.stdio_jsonl.stdout"),
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
        codecError(
          "exit",
          "failed waiting for stdio-jsonl process exit",
          cause,
        ),
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
      stdoutEvents(bytes.stdout).pipe(
        Stream.merge(terminatedEvent(bytes)),
        Stream.takeUntil(event => event._tag === "Terminated"),
        Stream.withSpan("firegrid.agent_event_pipeline.stdio_jsonl.outputs"),
      ),
    ),
  )

export const StdioJsonlSessionLive = (
  bytes: AgentByteStream,
): Layer.Layer<AgentSession> =>
  Layer.scoped(
    AgentSession,
    Effect.succeed({
      meta: {
        kind: codec,
        capabilities: StdioJsonlCapabilities,
      },
      toolUseMode: "client_result_roundtrip",
      send: event => writeJsonLine(bytes.stdin, event),
      outputs: outputs(bytes),
    }),
  ).pipe(
    Layer.withSpan("firegrid.agent_event_pipeline.stdio_jsonl.layer"),
  )
