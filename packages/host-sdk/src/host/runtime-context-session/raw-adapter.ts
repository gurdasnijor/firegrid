import { Prompt } from "@effect/ai"
import type {
  RuntimeContext,
  RuntimeEventRow,
  RuntimeLogLineRow,
} from "@firegrid/protocol/launch"
import {
  asRuntimeContextError,
  mapRuntimeContextError,
  type RuntimeContextError,
} from "@firegrid/runtime/errors"
import type { AgentInputEvent } from "@firegrid/runtime/events"
import {
  type AgentByteStream,
  type ProcessOutputChunk,
} from "@firegrid/runtime/sources/sandbox"
import {
  Clock,
  Effect,
  Schema,
  Scope,
  Stream,
} from "effect"
import type {
  PerContextRuntimeOutputWriter,
} from "../per-context-runtime-output.ts"
import {
  type RuntimeContextWorkflowSessionService,
} from "../runtime-context-workflow-core.ts"
import {
  makeRuntimeContextSessionAdapterService,
  makeRuntimeContextSessionCommandSender,
  makeRuntimeContextWorkflowSessionService,
  openRuntimeContextByteStream,
  runtimeContextSessionOwnerSessionId,
  scopedRuntimeContextWorkflowSessionLayer,
  type RuntimeContextSessionAdapterRequirements,
  type RuntimeContextSessionRecord,
} from "./common.ts"

type SequencedChunk = {
  readonly sequence: number
  readonly chunk: ProcessOutputChunk
}

interface RawRuntimeContextSession extends RuntimeContextSessionRecord {
  readonly stdin: WritableStreamDefaultWriter<Uint8Array>
}

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map(millis => new Date(millis).toISOString()),
)

const ownerSessionIdFor = (
  context: RuntimeContext,
  activityAttempt: number,
) => runtimeContextSessionOwnerSessionId("raw", context, activityAttempt)

const outputRowFromProcessChunk = (
  context: RuntimeContext,
  activityAttempt: number,
  sequence: number,
  chunk: Extract<ProcessOutputChunk, { readonly type: "output" }>,
): Effect.Effect<RuntimeEventRow | RuntimeLogLineRow, RuntimeContextError> =>
  Effect.gen(function* () {
    const rule = context.runtime.journal.find(candidate => candidate.source === chunk.channel)
    if (rule === undefined) {
      return yield* Effect.fail(asRuntimeContextError(
        "runtime-output.no-journal-rule",
        `no runtime journal rule for ${chunk.channel}`,
        context.contextId,
      ))
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

    return yield* Effect.fail(asRuntimeContextError(
      "runtime-output.invalid-journal-rule",
      `unsupported runtime journal rule ${rule.source}:${rule.format}->${rule.target}`,
      context.contextId,
    ))
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
  writer: PerContextRuntimeOutputWriter["Type"],
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
  session: RawRuntimeContextSession,
  bytes: AgentByteStream,
  writer: PerContextRuntimeOutputWriter["Type"],
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
          ).pipe(Effect.asVoid)
          : writeOutputChunk(
            writer,
            session.context,
            session.activityAttempt,
            sequence,
            chunk,
          )),
    )
  })

export const makeRawRuntimeContextWorkflowSessionService:
  Effect.Effect<
    RuntimeContextWorkflowSessionService,
    never,
    RuntimeContextSessionAdapterRequirements
  > =
  makeRuntimeContextSessionAdapterService<RawRuntimeContextSession>(({
    writer,
    stdinClaim,
    captured,
    scope,
    sessions,
  }) => {
    const startSession = (
      context: RuntimeContext,
      activityAttempt: number,
      _key: string,
    ) =>
      Effect.gen(function* () {
        const bytes = yield* Scope.extend(
          openRuntimeContextByteStream(context).pipe(Effect.provide(captured)),
          scope,
        )
        const session: RawRuntimeContextSession = {
          context,
          activityAttempt,
          ownerSessionId: ownerSessionIdFor(context, activityAttempt),
          stdin: bytes.stdin.getWriter(),
        }
        return {
          session,
          run: runRawProcess(session, bytes, writer).pipe(
            Effect.catchAll(cause =>
              Effect.logError("[host-sdk] raw runtime session failed").pipe(
                Effect.annotateLogs({ contextId: context.contextId, cause }),
              )),
            Effect.ensuring(Effect.sync(() => session.stdin.releaseLock())),
          ),
        }
      })

    const sendCommand = makeRuntimeContextSessionCommandSender<RawRuntimeContextSession>({
      ownerKind: "raw",
      stdinClaim,
      prepare: (context, session, command) =>
        Effect.gen(function* () {
          const bytes = yield* rawBytesForInput(command.event)
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
        }),
    })

    return makeRuntimeContextWorkflowSessionService({
      ownerKind: "raw",
      sessions,
      scope,
      startSession,
      sendCommand,
    })
  })

export const RawRuntimeContextWorkflowSessionLive = scopedRuntimeContextWorkflowSessionLayer(
  makeRawRuntimeContextWorkflowSessionService,
)
