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
  commandForContext,
  streamSandboxProcess,
  type ProcessOutputChunk,
  type SandboxProviderError,
} from "@firegrid/runtime/sources/sandbox"
import {
  Clock,
  Effect,
  Queue,
  Schema,
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
  removeRuntimeContextSession,
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
  readonly stdin: Queue.Queue<Uint8Array>
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

const runRawProcess = (
  session: RawRuntimeContextSession,
  writer: PerContextRuntimeOutputWriter["Type"],
) =>
  Effect.gen(function* () {
    const command = yield* commandForContext(session.context)
    yield* streamSandboxProcess({
      labels: {
        firegridRuntimeContextId: session.context.contextId,
      },
      ...(session.context.runtime.config.cwd === undefined
        ? {}
        : { workingDir: session.context.runtime.config.cwd }),
      providerConfig: {
        contextId: session.context.contextId,
      },
      command: {
        ...command,
        stdin: Stream.fromQueue(session.stdin),
      },
    }).pipe(
      Stream.mapError((cause: SandboxProviderError) =>
        asRuntimeContextError(
          `sandbox.${cause.op}`,
          cause.message,
          session.context.contextId,
          cause,
        )),
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
      key: string,
    ): Effect.Effect<RawRuntimeContextSession, RuntimeContextError> =>
      Effect.gen(function* () {
        const stdin = yield* Queue.unbounded<Uint8Array>()
        const session: RawRuntimeContextSession = {
          context,
          activityAttempt,
          ownerSessionId: ownerSessionIdFor(context, activityAttempt),
          stdin,
        }
        yield* runRawProcess(session, writer).pipe(
          Effect.provide(captured),
          Effect.catchAll(cause =>
            Effect.logError("[host-sdk] raw runtime session failed").pipe(
              Effect.annotateLogs({ contextId: context.contextId, cause }),
            )),
          Effect.ensuring(removeRuntimeContextSession(sessions, key)),
          Effect.forkIn(scope),
        )
        return session
      })

    const sendCommand = makeRuntimeContextSessionCommandSender<RawRuntimeContextSession>({
      ownerKind: "raw",
      stdinClaim,
      prepare: (context, session, command) =>
        Effect.gen(function* () {
          const bytes = yield* rawBytesForInput(command.event)
          return {
            byteLength: bytes.byteLength,
            emit: Queue.offer(session.stdin, bytes),
          }
        }),
    })

    return makeRuntimeContextWorkflowSessionService({
      ownerKind: "raw",
      sessions,
      startSession,
      sendCommand,
    })
  })

export const RawRuntimeContextWorkflowSessionLive = scopedRuntimeContextWorkflowSessionLayer(
  makeRawRuntimeContextWorkflowSessionService,
)
