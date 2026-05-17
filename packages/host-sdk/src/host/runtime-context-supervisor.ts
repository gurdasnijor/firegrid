import { IdGenerator } from "@effect/ai"
import type {
  RuntimeAgentProtocol,
  RuntimeContext,
  RuntimeEventRow,
  RuntimeLogLineRow,
} from "@firegrid/protocol/launch"
import { Clock, Context, Effect, Layer, Option, Queue, Ref, Stream } from "effect"
import {
  AcpSessionLive,
  AgentSession,
  AgentCodecError,
  StdioJsonlSessionLive,
} from "@firegrid/runtime/codecs"
import {
  type AgentInputEvent,
  type AgentOutputEvent,
  encodeRuntimeAgentOutputEnvelope,
} from "@firegrid/runtime/events"
import {
  RuntimeContextError,
  RuntimeEventAppendAndGet,
  RuntimeLogLineAppendAndGet,
  RuntimeOutputJournalLayer,
  asRuntimeContextError,
  mapRuntimeContextError,
} from "@firegrid/runtime/host-substrate"
import {
  SandboxProvider,
  SandboxStdinEmissionClaim,
  SandboxStdinEmissionClaimLive,
  SandboxSupervisorCommandTable,
  commandForContext,
  stdinEmissionCommandId,
  streamSandboxProcess,
  type ProcessOutputChunk,
  type SandboxProviderError,
} from "@firegrid/runtime/sources/sandbox"
import { hostOwnedStreamUrl, runtimeContextOutputStreamUrl } from "@firegrid/protocol/launch"
import { RuntimeOutputTable } from "@firegrid/protocol/launch"
import { RuntimeHostConfig } from "./config.ts"

export interface RuntimeContextSupervisorStartEvidence {
  readonly contextId: string
  readonly activityAttempt: number
  readonly supervisorSessionId: string
  readonly startCommandId: string
}

export interface RuntimeContextSupervisorCommand {
  readonly commandId: string
  readonly event: AgentInputEvent
}

export interface RuntimeContextSupervisorCommandAccepted {
  readonly contextId: string
  readonly activityAttempt: number
  readonly supervisorSessionId: string
  readonly commandId: string
}

interface RuntimeContextSupervisorSession {
  readonly evidence: RuntimeContextSupervisorStartEvidence
  readonly commands: Queue.Queue<RuntimeContextSupervisorCommand>
}

type RuntimeContextSupervisorSessions = Map<string, RuntimeContextSupervisorSession>

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map(millis => new Date(millis).toISOString()),
)

const sessionKey = (
  context: RuntimeContext,
  activityAttempt: number,
) => `${context.contextId}:${activityAttempt}`

const startCommandId = (
  context: RuntimeContext,
  activityAttempt: number,
) => `runtime-start-${context.contextId}-${activityAttempt}`

const supervisorSessionId = (
  context: RuntimeContext,
  activityAttempt: number,
) => `supervisor-${context.contextId}-${activityAttempt}`

const agentProtocolForContext = (
  context: RuntimeContext,
): RuntimeAgentProtocol => context.runtime.config.agentProtocol ?? "raw"

const runtimeContextOutputTableLayer = (
  hostConfig: RuntimeHostConfig["Type"],
  context: RuntimeContext,
) =>
  RuntimeOutputTable.layer({
    streamOptions: {
      url: runtimeContextOutputStreamUrl({
        baseUrl: hostConfig.durableStreamsBaseUrl,
        prefix: context.host.streamPrefix,
        contextId: context.contextId,
      }),
      contentType: "application/json",
      ...(hostConfig.headers === undefined ? {} : { headers: hostConfig.headers }),
    },
  })

const sandboxSupervisorCommandTableLayer = (
  hostConfig: RuntimeHostConfig["Type"],
  context: RuntimeContext,
) =>
  SandboxSupervisorCommandTable.layer({
    streamOptions: {
      url: hostOwnedStreamUrl({
        baseUrl: hostConfig.durableStreamsBaseUrl,
        prefix: context.host.streamPrefix,
        segment: "durableTools",
      }),
      contentType: "application/json",
      ...(hostConfig.headers === undefined ? {} : { headers: hostConfig.headers }),
    },
  })

const runtimeOutputRawFromAgentEvent = (
  contextId: string,
  event: AgentOutputEvent,
): Effect.Effect<string, RuntimeContextError> =>
  Effect.try({
    try: () => encodeRuntimeAgentOutputEnvelope(event),
    catch: cause =>
      asRuntimeContextError(
        "runtime-output.agent-event.encode",
        "failed to encode agent output event",
        contextId,
        cause,
      ),
  })

const outputRowFromAgentEvent = (
  context: RuntimeContext,
  activityAttempt: number,
  sequence: number,
  event: AgentOutputEvent,
): Effect.Effect<RuntimeEventRow, RuntimeContextError> =>
  Effect.gen(function* () {
    const receivedAt = yield* nowIso
    return {
      eventId: {
        contextId: context.contextId,
        activityAttempt,
        target: "events",
        sequence,
      },
      contextId: context.contextId,
      activityAttempt,
      sequence,
      source: "stdout",
      format: "jsonl",
      receivedAt,
      raw: yield* runtimeOutputRawFromAgentEvent(context.contextId, event),
    }
  })

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

const mapSandboxProviderError = (
  contextId: string,
) =>
  Effect.mapError((cause: SandboxProviderError) =>
    asRuntimeContextError(
      `sandbox.${cause.op}`,
      cause.message,
      contextId,
      cause,
    ))

const codecLayer = (
  protocol: Exclude<RuntimeAgentProtocol, "raw">,
  bytes: Parameters<typeof StdioJsonlSessionLive>[0],
): Layer.Layer<AgentSession, AgentCodecError> => {
  switch (protocol) {
    case "stdio-jsonl":
      return StdioJsonlSessionLive(bytes)
    case "acp":
      return AcpSessionLive(bytes).pipe(
        Layer.provide(Layer.succeed(IdGenerator.IdGenerator, IdGenerator.defaultIdGenerator)),
      )
    default:
      return protocol satisfies never
  }
}

const runCodecOutputPump = (options: {
  readonly context: RuntimeContext
  readonly activityAttempt: number
  readonly protocol: Exclude<RuntimeAgentProtocol, "raw">
  readonly session: RuntimeContextSupervisorSession
}) =>
  Effect.gen(function* () {
    const outputSink = yield* RuntimeEventAppendAndGet
    const logLines = yield* RuntimeLogLineAppendAndGet
    const command = yield* commandForContext(options.context)
    const provider = yield* SandboxProvider
    const sandbox = yield* provider.getOrCreate({
      labels: {
        firegridRuntimeContextId: options.context.contextId,
      },
      ...(options.context.runtime.config.cwd === undefined ? {} : {
        workingDir: options.context.runtime.config.cwd,
      }),
      providerConfig: {
        contextId: options.context.contextId,
      },
    }).pipe(mapSandboxProviderError(options.context.contextId))
    const bytes = yield* provider.openBytePipe(sandbox, command).pipe(
      mapSandboxProviderError(options.context.contextId),
    )

    const runSession = Effect.gen(function* () {
      const agent = yield* AgentSession
      const stdinClaim = yield* SandboxStdinEmissionClaim
      const commandPump = Stream.fromQueue(options.session.commands).pipe(
        Stream.mapEffect(command =>
          Effect.gen(function*() {
            const bytes = rawBytesFromInputEvent(command.event)
            const claimId = yield* stdinEmissionCommandId({
              contextId: options.context.contextId,
              inputId: command.commandId,
              bytes,
            })
            const claimed = yield* stdinClaim.claim({
              commandId: claimId,
              contextId: options.context.contextId,
              inputId: command.commandId,
              byteLength: bytes.byteLength,
            }).pipe(
              Effect.mapError(cause =>
                asRuntimeContextError(
                  "sandbox.codec.command.claim",
                  "failed to claim codec command emission",
                  options.context.contextId,
                  cause,
                )),
            )
            if (!claimed) return
            yield* agent.send(command.event).pipe(
              Effect.mapError(cause =>
                asRuntimeContextError(
                  `agent-codec.${cause.op}`,
                  cause.message,
                  options.context.contextId,
                  cause,
                )),
            )
          })),
        Stream.runDrain,
      )
      yield* commandPump.pipe(Effect.forkScoped)

      const stderr = Stream.fromReadableStream({
        evaluate: () => bytes.stderr,
        onError: cause =>
          asRuntimeContextError(
            "sandbox.codec.stderr",
            "failed reading codec process stderr",
            options.context.contextId,
            cause,
          ),
        releaseLockOnEnd: true,
      }).pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.mapAccum(0, (sequence, line) => [
          sequence + 1,
          { sequence, line },
        ] as const),
        Stream.mapEffect(({ sequence, line }) =>
          nowIso.pipe(
            Effect.map(receivedAt =>
              logLineRowFromCodecStderr({
                context: options.context,
                activityAttempt: options.activityAttempt,
                sequence,
                raw: line,
                receivedAt,
              })),
            Effect.flatMap(row =>
              logLines.append(row).pipe(
                mapRuntimeContextError(
                  "runtime-output.codec.stderr.write",
                  "failed to write codec stderr runtime log row",
                  options.context.contextId,
                ),
              )),
          )),
        Stream.runDrain,
      )
      yield* stderr.pipe(Effect.forkScoped)

      yield* agent.outputs.pipe(
        Stream.mapError(cause =>
          asRuntimeContextError(
            `agent-codec.${cause.op}`,
            cause.message,
            options.context.contextId,
            cause,
          )),
        Stream.mapAccum(0, (sequence, event) => [
          sequence + 1,
          { sequence, event },
        ] as const),
        Stream.mapEffect(({ sequence, event }) =>
          outputRowFromAgentEvent(
            options.context,
            options.activityAttempt,
            sequence,
            event,
          )),
        Stream.runForEach(row =>
          outputSink.append(row).pipe(
            mapRuntimeContextError(
              "runtime-output.codec.write",
              "failed to write codec runtime output row",
              options.context.contextId,
            ),
          )),
      )
    })

    yield* runSession.pipe(
      Effect.provide(codecLayer(options.protocol, bytes)),
      Effect.scoped,
    )
  })

const rawBytesFromInputEvent = (
  event: AgentInputEvent,
): Uint8Array => {
  const text = JSON.stringify(event)
  return new TextEncoder().encode(`${text}\n`)
}

const rawOutputRowFromProcessChunk = (
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
        receivedAt,
        raw: chunk.text,
      }
    }

    return yield* Effect.fail(asRuntimeContextError(
      "runtime-output.invalid-journal-rule",
      `unsupported runtime journal rule ${rule.source}:${rule.format}->${rule.target}`,
      context.contextId,
    ))
  })

const runRawOutputPump = (options: {
  readonly context: RuntimeContext
  readonly activityAttempt: number
  readonly session: RuntimeContextSupervisorSession
}) =>
  Effect.gen(function* () {
    const appendEvent = yield* RuntimeEventAppendAndGet
    const appendLog = yield* RuntimeLogLineAppendAndGet
    const stdinClaim = yield* SandboxStdinEmissionClaim
    const stdin = Stream.fromQueue(options.session.commands).pipe(
      Stream.mapEffect(command =>
        Effect.gen(function*() {
          const bytes = rawBytesFromInputEvent(command.event)
          const claimId = yield* stdinEmissionCommandId({
            contextId: options.context.contextId,
            inputId: command.commandId,
            bytes,
          })
          const claimed = yield* stdinClaim.claim({
            commandId: claimId,
            contextId: options.context.contextId,
            inputId: command.commandId,
            byteLength: bytes.byteLength,
          })
          return claimed ? Option.some(bytes) : Option.none<Uint8Array>()
        })),
      Stream.filterMap(value => value),
    )
    const command = yield* commandForContext(options.context)
    const writeOutputChunk = (
      sequence: number,
      chunk: Extract<ProcessOutputChunk, { readonly type: "output" }>,
    ) =>
      rawOutputRowFromProcessChunk(options.context, options.activityAttempt, sequence, chunk).pipe(
        Effect.flatMap((row) => {
          if (row.source === "stdout") {
            return appendEvent.append(row).pipe(Effect.asVoid)
          }
          return appendLog.append(row).pipe(Effect.asVoid)
        }),
        mapRuntimeContextError(
          "runtime-output.write",
          "failed to write runtime data-plane row",
          options.context.contextId,
        ),
      )
    yield* streamSandboxProcess({
      labels: {
        firegridRuntimeContextId: options.context.contextId,
      },
      ...(options.context.runtime.config.cwd === undefined ? {} : { workingDir: options.context.runtime.config.cwd }),
      providerConfig: {
        contextId: options.context.contextId,
      },
      command: {
        ...command,
        stdin,
      },
    }).pipe(
      Stream.mapError((cause: SandboxProviderError) => {
        const op = `sandbox.${cause.op}`
        return asRuntimeContextError(op, cause.message, options.context.contextId, cause)
      }),
      Stream.mapAccum(0, (sequence, chunk): readonly [number, { readonly sequence: number; readonly chunk: ProcessOutputChunk }] => [
        sequence + 1,
        { sequence, chunk },
      ]),
      Stream.tap(({ chunk, sequence }) =>
        chunk.type === "exit"
          ? outputRowFromAgentEvent(
            options.context,
            options.activityAttempt,
            sequence,
            { _tag: "Terminated", exitCode: chunk.exitCode },
          ).pipe(Effect.flatMap(row => appendEvent.append(row).pipe(Effect.asVoid)))
          : writeOutputChunk(sequence, chunk)),
      Stream.runDrain,
    )
  })

export class RuntimeContextSupervisor extends Context.Tag(
  "@firegrid/host-sdk/RuntimeContextSupervisor",
)<RuntimeContextSupervisor, {
  readonly startOrAttach: (
    context: RuntimeContext,
    activityAttempt: number,
  ) => Effect.Effect<RuntimeContextSupervisorStartEvidence, RuntimeContextError>
  readonly send: (
    context: RuntimeContext,
    activityAttempt: number,
    command: RuntimeContextSupervisorCommand,
  ) => Effect.Effect<RuntimeContextSupervisorCommandAccepted, RuntimeContextError>
}>() {}

export const RuntimeContextSupervisorLive = Layer.scoped(
  RuntimeContextSupervisor,
  Effect.gen(function*() {
      const hostConfig = yield* RuntimeHostConfig
      const hostScope = yield* Effect.scope
      const sessions = yield* Ref.make<RuntimeContextSupervisorSessions>(new Map())
      const startLock = yield* Effect.makeSemaphore(1)

      const startOrAttach = (
        context: RuntimeContext,
        activityAttempt: number,
      ): Effect.Effect<RuntimeContextSupervisorStartEvidence, RuntimeContextError> =>
        startLock.withPermits(1)(Effect.gen(function*() {
          const key = sessionKey(context, activityAttempt)
          const current = yield* Ref.get(sessions)
          const existing = current.get(key)
          if (existing !== undefined) return existing.evidence

          const evidence: RuntimeContextSupervisorStartEvidence = {
            contextId: context.contextId,
            activityAttempt,
            supervisorSessionId: supervisorSessionId(context, activityAttempt),
            startCommandId: startCommandId(context, activityAttempt),
          }
          const commands = yield* Queue.unbounded<RuntimeContextSupervisorCommand>()
          const session: RuntimeContextSupervisorSession = { evidence, commands }
          yield* Ref.update(sessions, (map) => new Map(map).set(key, session))
          const protocol = agentProtocolForContext(context)
          const pump = protocol === "raw"
            ? runRawOutputPump({ context, activityAttempt, session })
            : runCodecOutputPump({ context, activityAttempt, protocol, session })
          yield* pump.pipe(
            Effect.provide(RuntimeOutputJournalLayer),
            Effect.provide(runtimeContextOutputTableLayer(hostConfig, context)),
            Effect.provide(SandboxStdinEmissionClaimLive),
            Effect.provide(sandboxSupervisorCommandTableLayer(hostConfig, context)),
            Effect.catchAll(error =>
              outputRowFromAgentEvent(context, activityAttempt, 0, {
                _tag: "Error",
                cause: error,
                recoverable: false,
              }).pipe(
                Effect.flatMap(row => Effect.flatMap(RuntimeEventAppendAndGet, output => output.append(row))),
                Effect.provide(RuntimeOutputJournalLayer),
                Effect.provide(runtimeContextOutputTableLayer(hostConfig, context)),
                Effect.ignore,
              )),
            Effect.ensuring(Queue.shutdown(commands)),
            Effect.forkIn(hostScope),
          )
          return evidence
        }))

      const send = (
        context: RuntimeContext,
        activityAttempt: number,
        command: RuntimeContextSupervisorCommand,
      ): Effect.Effect<RuntimeContextSupervisorCommandAccepted, RuntimeContextError> =>
        Effect.gen(function*() {
          const key = sessionKey(context, activityAttempt)
          const current = yield* Ref.get(sessions)
          const session = current.get(key)
          if (session === undefined) {
            return yield* Effect.fail(asRuntimeContextError(
              "runtime-context.supervisor.session-missing",
              "runtime context supervisor session is not started",
              context.contextId,
            ))
          }
          yield* Queue.offer(session.commands, command)
          return {
            contextId: context.contextId,
            activityAttempt,
            supervisorSessionId: session.evidence.supervisorSessionId,
            commandId: command.commandId,
          }
        })

      return RuntimeContextSupervisor.of({
        startOrAttach,
        send,
      })
    }),
)
