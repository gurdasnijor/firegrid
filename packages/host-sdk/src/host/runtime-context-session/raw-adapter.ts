import { Prompt } from "@effect/ai"
import type {
  RuntimeContext,
  RuntimeEventRow,
  RuntimeLogLineRow,
} from "@firegrid/protocol/launch"
import {
  asRuntimeContextError,
  mapRuntimeContextError,
  RuntimeContextError,
} from "@firegrid/runtime/errors"
import type { AgentInputEvent } from "@firegrid/runtime/events"
import {
  commandForContext,
  RuntimeEnvResolverPolicy,
  SandboxStdinEmissionClaim,
  streamSandboxProcess,
  type ProcessOutputChunk,
  type SandboxProvider,
  type SandboxProviderError,
} from "@firegrid/runtime/sources/sandbox"
import {
  Clock,
  Effect,
  Layer,
  Queue,
  Ref,
  Schema,
  Stream,
} from "effect"
import {
  PerContextRuntimeOutputWriter,
} from "../per-context-runtime-output.ts"
import {
  RuntimeContextWorkflowSession,
  type RuntimeContextSessionCommand,
  type RuntimeContextSessionCommandAccepted,
  type RuntimeContextSessionStartedEvidence,
} from "../runtime-context-workflow-core.ts"

type SequencedChunk = {
  readonly sequence: number
  readonly chunk: ProcessOutputChunk
}

interface RawRuntimeContextSession {
  readonly context: RuntimeContext
  readonly activityAttempt: number
  readonly ownerSessionId: string
  readonly stdin: Queue.Queue<Uint8Array>
}

export const runtimeContextSessionOwnerSessionId = (
  ownerKind: "raw" | "codec",
  context: RuntimeContext,
  activityAttempt: number,
) => `${ownerKind}:${context.contextId}:${activityAttempt}`

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map(millis => new Date(millis).toISOString()),
)

const rawSessionKey = (
  context: RuntimeContext,
  activityAttempt: number,
) => `${context.contextId}:${activityAttempt}`

const ownerSessionIdFor = (
  context: RuntimeContext,
  activityAttempt: number,
) => runtimeContextSessionOwnerSessionId("raw", context, activityAttempt)

const startedEvidence = (
  context: RuntimeContext,
  activityAttempt: number,
): RuntimeContextSessionStartedEvidence => ({
  contextId: context.contextId,
  activityAttempt,
  ownerKind: "raw",
  ownerSessionId: ownerSessionIdFor(context, activityAttempt),
  startCommandId: `start-${context.contextId}-${activityAttempt}`,
})

const acceptedCommand = (
  session: RawRuntimeContextSession,
  command: RuntimeContextSessionCommand,
): RuntimeContextSessionCommandAccepted => ({
  contextId: session.context.contextId,
  activityAttempt: session.activityAttempt,
  commandId: command.commandId,
  ownerSessionId: session.ownerSessionId,
})

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

export const RawRuntimeContextWorkflowSessionLive: Layer.Layer<
  RuntimeContextWorkflowSession,
  never,
  | PerContextRuntimeOutputWriter
  | RuntimeEnvResolverPolicy
  | SandboxProvider
  | SandboxStdinEmissionClaim
> = Layer.scoped(
  RuntimeContextWorkflowSession,
  Effect.gen(function* () {
    const writer = yield* PerContextRuntimeOutputWriter
    const stdinClaim = yield* SandboxStdinEmissionClaim
    const captured = yield* Effect.context<
      | RuntimeEnvResolverPolicy
      | SandboxProvider
    >()
    const scope = yield* Effect.scope
    const sessions = yield* Ref.make(new Map<string, RawRuntimeContextSession>())

    const startOrAttach = (
      context: RuntimeContext,
      activityAttempt: number,
    ): Effect.Effect<RuntimeContextSessionStartedEvidence, RuntimeContextError> =>
      Effect.gen(function* () {
        const key = rawSessionKey(context, activityAttempt)
        const current = yield* Ref.get(sessions)
        if (current.has(key)) return startedEvidence(context, activityAttempt)

        const stdin = yield* Queue.unbounded<Uint8Array>()
        const session: RawRuntimeContextSession = {
          context,
          activityAttempt,
          ownerSessionId: ownerSessionIdFor(context, activityAttempt),
          stdin,
        }
        yield* Ref.update(sessions, map => new Map([...map, [key, session]]))
        yield* runRawProcess(session, writer).pipe(
          Effect.provide(captured),
          Effect.catchAll(cause =>
            Effect.logError("[host-sdk] raw runtime session failed").pipe(
              Effect.annotateLogs({ contextId: context.contextId, cause }),
            )),
          Effect.ensuring(Ref.update(sessions, map => {
            const next = new Map(map)
            next.delete(key)
            return next
          })),
          Effect.forkIn(scope),
        )
        return startedEvidence(context, activityAttempt)
      })

    const getOrStart = (
      context: RuntimeContext,
      activityAttempt: number,
    ) =>
      Effect.gen(function* () {
        yield* startOrAttach(context, activityAttempt)
        const session = (yield* Ref.get(sessions)).get(rawSessionKey(context, activityAttempt))
        if (session === undefined) {
          return yield* Effect.fail(asRuntimeContextError(
            "runtime-context.raw-session.attach",
            "raw runtime session did not attach",
            context.contextId,
          ))
        }
        return session
      })

    const send = (
      context: RuntimeContext,
      activityAttempt: number,
      command: RuntimeContextSessionCommand,
    ) =>
      Effect.gen(function* () {
        const session = yield* getOrStart(context, activityAttempt)
        const bytes = yield* rawBytesForInput(command.event)
        const claimed = yield* stdinClaim.claim({
          commandId: command.commandId,
          contextId: context.contextId,
          inputId: command.commandId,
          byteLength: bytes.byteLength,
        }).pipe(
          mapRuntimeContextError(
            "runtime-context.raw-session.claim",
            "failed to claim raw runtime input command",
            context.contextId,
          ),
        )
        if (claimed) {
          yield* Queue.offer(session.stdin, bytes)
        }
        return acceptedCommand(session, command)
      })

    return RuntimeContextWorkflowSession.of({
      startOrAttach,
      send,
    })
  }),
)
