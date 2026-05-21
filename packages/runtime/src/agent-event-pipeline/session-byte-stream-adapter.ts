import { Prompt } from "@effect/ai"
import type {
  RuntimeContext,
  RuntimeEventRow,
  RuntimeLogLineRow,
} from "@firegrid/protocol/launch"
import {
  Clock,
  Effect,
  Ref,
  Schema,
  Stream,
} from "effect"
import type {
  AgentInputEvent,
  AgentOutputEvent,
} from "./events/index.ts"
import {
  asRuntimeContextError,
  mapRuntimeContextError,
  type RuntimeContextError,
} from "../runtime-errors.ts"
import type {
  AgentByteStream,
  ProcessOutputChunk,
} from "./sources/sandbox/index.ts"

type SequencedChunk = {
  readonly sequence: number
  readonly chunk: ProcessOutputChunk
}

type WriteEffect<Row> = Effect.Effect<Row, unknown>

export interface RuntimeContextSessionOutputWriter {
  readonly appendAgentEvent: (
    context: RuntimeContext, activityAttempt: number, sequence: number, event: AgentOutputEvent,
  ) => WriteEffect<RuntimeEventRow>
  readonly appendEventRow: (context: RuntimeContext, row: RuntimeEventRow) => WriteEffect<RuntimeEventRow>
  readonly appendLogLine: (context: RuntimeContext, row: RuntimeLogLineRow) => WriteEffect<RuntimeLogLineRow>
}

export interface RuntimeRawByteSession {
  readonly context: RuntimeContext
  readonly activityAttempt: number
  readonly ownerSessionId: string
  readonly stdin: WritableStreamDefaultWriter<Uint8Array>
}

export interface RuntimeRawByteSessionStart {
  readonly session: RuntimeRawByteSession
  readonly run: Effect.Effect<void, RuntimeContextError>
}

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map(millis => new Date(millis).toISOString()),
)

const outputRowFromProcessChunk = (
  context: RuntimeContext,
  activityAttempt: number,
  sequence: number,
  chunk: Extract<ProcessOutputChunk, { readonly type: "output" }>,
): Effect.Effect<RuntimeEventRow | RuntimeLogLineRow, RuntimeContextError> =>
  Effect.gen(function* () {
    const rule = context.runtime.journal.find(candidate => candidate.source === chunk.channel)
    if (rule === undefined) {
      return yield* asRuntimeContextError(
        "runtime-output.no-journal-rule",
        `no runtime journal rule for ${chunk.channel}`,
        context.contextId,
      )
    }

    const receivedAt = yield* nowIso
    const rowBase = {
      contextId: context.contextId,
      activityAttempt,
      sequence,
      receivedAt,
    }
    if (rule.target === "events" && rule.format === "jsonl" && chunk.channel === "stdout") {
      return {
        ...rowBase,
        eventId: {
          contextId: context.contextId,
          activityAttempt,
          target: "events",
          sequence,
        },
        source: "stdout",
        format: "jsonl",
        raw: chunk.text,
      }
    }

    if (rule.target === "logs" && rule.format === "text-lines" && chunk.channel === "stderr") {
      return {
        ...rowBase,
        logLineId: {
          contextId: context.contextId,
          activityAttempt,
          target: "logs",
          sequence,
        },
        source: "stderr",
        format: "text-lines",
        raw: chunk.text,
      }
    }

    return yield* asRuntimeContextError(
      "runtime-output.invalid-journal-rule",
      `unsupported runtime journal rule ${rule.source}:${rule.format}->${rule.target}`,
      context.contextId,
    )
  })

const promptText = (
  prompt: Prompt.UserMessage,
): string => {
  const encoded = Schema.encodeSync(Prompt.UserMessage)(prompt)
  const content = encoded.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const text = content.flatMap((part) => {
      if (typeof part !== "object" || part === null) return []
      const record = part as Record<string, unknown>
      return typeof record.text === "string" ? [record.text] : []
    })
    if (text.length > 0) return text.join("\n")
  }
  return JSON.stringify(encoded)
}

const rawBytesForInput = (
  event: AgentInputEvent,
): Effect.Effect<Uint8Array, RuntimeContextError> => {
  const encoder = new TextEncoder()
  switch (event._tag) {
    case "Prompt":
      return Effect.succeed(encoder.encode(`${promptText(event.prompt)}\n`))
    case "ToolResult":
    case "PermissionResponse":
    case "Cancel":
    case "Terminate":
      return Effect.succeed(encoder.encode(`${JSON.stringify(event)}\n`))
  }
}

const writeOutputChunk = (
  writer: RuntimeContextSessionOutputWriter,
  context: RuntimeContext,
  activityAttempt: number,
  sequence: number,
  chunk: Extract<ProcessOutputChunk, { readonly type: "output" }>,
) =>
  outputRowFromProcessChunk(context, activityAttempt, sequence, chunk).pipe(
    Effect.flatMap((row) => {
      if (row.source === "stdout") {
        return writer.appendEventRow(context, row).pipe(Effect.asVoid)
      }
      return writer.appendLogLine(context, row).pipe(Effect.asVoid)
    }),
    mapRuntimeContextError(
      "runtime-output.write",
      "failed to write runtime data-plane row",
      context.contextId,
    ),
  )

const outputLines = (
  contextId: string,
  channel: "stdout" | "stderr",
  stream: ReadableStream<Uint8Array>,
): Stream.Stream<Extract<ProcessOutputChunk, { readonly type: "output" }>, RuntimeContextError> =>
  Stream.fromReadableStream({
    evaluate: () => stream,
    onError: cause =>
      asRuntimeContextError(
        `sandbox.raw.${channel}`,
        `failed reading raw process ${channel}`,
        contextId,
        cause,
      ),
    releaseLockOnEnd: true,
  }).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.map(text => ({
      type: "output" as const,
      channel,
      text,
    })),
  )

const runRawProcess = (
  session: RuntimeRawByteSession,
  bytes: AgentByteStream,
  writer: RuntimeContextSessionOutputWriter,
) =>
  Effect.gen(function* () {
    const output = Stream.merge(
      outputLines(session.context.contextId, "stdout", bytes.stdout),
      outputLines(session.context.contextId, "stderr", bytes.stderr),
    )
    const exit = Stream.fromEffect(
      bytes.exit.pipe(
        Effect.map(exit => ({
          type: "exit" as const,
          exitCode: exit.exitCode ?? 0,
        })),
        Effect.mapError(cause =>
          asRuntimeContextError(
            "sandbox.raw.exit",
            "failed waiting for raw process exit",
            session.context.contextId,
            cause,
          )),
      ),
    )
    yield* output.pipe(
      Stream.concat(exit),
      Stream.mapAccum(0, (sequence, chunk): readonly [number, SequencedChunk] => [
        sequence + 1,
        { sequence, chunk },
      ]),
      Stream.runForEach(({ chunk, sequence }) =>
        chunk.type === "exit"
          ? writer.appendAgentEvent(
            session.context,
            session.activityAttempt,
            sequence,
            { _tag: "Terminated", exitCode: chunk.exitCode },
          ).pipe(
            mapRuntimeContextError(
              "runtime-output.raw.terminated.write",
              "failed to write raw runtime terminal event row",
              session.context.contextId,
            ),
            Effect.asVoid,
          )
          : writeOutputChunk(
            writer,
            session.context,
            session.activityAttempt,
            sequence,
            chunk,
          )),
    )
  })

export const makeRawRuntimeContextByteSession = (options: {
  readonly context: RuntimeContext
  readonly activityAttempt: number
  readonly ownerSessionId: string
  readonly bytes: AgentByteStream
  readonly writer: RuntimeContextSessionOutputWriter
}): Effect.Effect<RuntimeRawByteSessionStart, RuntimeContextError> =>
  Effect.gen(function* () {
    const stdin = yield* Effect.try({
      try: () => options.bytes.stdin.getWriter(),
      catch: cause =>
        asRuntimeContextError(
          "sandbox.raw.stdin.writer",
          "failed opening raw runtime stdin writer",
          options.context.contextId,
          cause,
        ),
    })
    const session: RuntimeRawByteSession = {
      context: options.context,
      activityAttempt: options.activityAttempt,
      ownerSessionId: options.ownerSessionId,
      stdin,
    }
    return {
      session,
      run: runRawProcess(session, options.bytes, options.writer).pipe(
        Effect.ensuring(Effect.sync(() => session.stdin.releaseLock())),
      ),
    }
  })

export const prepareRawRuntimeContextInput = (
  context: RuntimeContext,
  session: RuntimeRawByteSession,
  event: AgentInputEvent,
): Effect.Effect<{
  readonly byteLength: number
  readonly emit: Effect.Effect<void, RuntimeContextError>
}, RuntimeContextError> =>
  Effect.gen(function* () {
    const bytes = yield* rawBytesForInput(event)
    return {
      byteLength: bytes.byteLength,
      emit: Effect.tryPromise({
        try: () => session.stdin.write(bytes),
        catch: cause =>
          asRuntimeContextError(
            "sandbox.raw.stdin.write",
            "failed writing raw runtime stdin",
            context.contextId,
            cause,
          ),
      }),
    }
  })

const codecStderrLines = (
  contextId: string,
  stderr: ReadableStream<Uint8Array>,
): Stream.Stream<string, RuntimeContextError> =>
  Stream.fromReadableStream({
    evaluate: () => stderr,
    onError: cause =>
      asRuntimeContextError(
        "sandbox.codec.stderr",
        "failed reading codec process stderr",
        contextId,
        cause,
      ),
    releaseLockOnEnd: true,
  }).pipe(
    Stream.decodeText(),
    Stream.splitLines,
  )

const logLineRowFromCodecStderr = (options: {
  readonly context: RuntimeContext
  readonly activityAttempt: number
  readonly sequence: number
  readonly raw: string
  readonly receivedAt: string
}): RuntimeLogLineRow => ({
  logLineId: {
    contextId: options.context.contextId,
    activityAttempt: options.activityAttempt,
    target: "logs",
    sequence: options.sequence,
  },
  contextId: options.context.contextId,
  activityAttempt: options.activityAttempt,
  sequence: options.sequence,
  source: "stderr",
  format: "text-lines",
  receivedAt: options.receivedAt,
  raw: options.raw,
})

export const runCodecRuntimeContextStderrJournal = (options: {
  readonly context: RuntimeContext
  readonly activityAttempt: number
  readonly bytes: AgentByteStream
  readonly writer: RuntimeContextSessionOutputWriter
}) =>
  Effect.gen(function* () {
    const sequenceRef = yield* Ref.make(0)
    yield* codecStderrLines(options.context.contextId, options.bytes.stderr).pipe(
      Stream.mapEffect(line =>
        Effect.gen(function* () {
          const sequence = yield* Ref.getAndUpdate(sequenceRef, value => value + 1)
          const receivedAt = yield* nowIso
          yield* options.writer.appendLogLine(options.context, logLineRowFromCodecStderr({
            context: options.context,
            activityAttempt: options.activityAttempt,
            sequence,
            raw: line,
            receivedAt,
          })).pipe(
            mapRuntimeContextError(
              "runtime-output.codec.stderr.write",
              "failed to write codec stderr runtime log row",
              options.context.contextId,
            ),
          )
        })),
      Stream.runDrain,
    )
  }).pipe(
    Effect.withSpan("firegrid.agent_event_pipeline.codec.stderr_journal", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": options.context.contextId,
        "firegrid.activity_attempt": options.activityAttempt,
      },
    }),
  )
