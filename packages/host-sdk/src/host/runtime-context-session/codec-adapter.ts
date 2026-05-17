import { IdGenerator } from "@effect/ai"
import type {
  RuntimeAgentProtocol,
  RuntimeContext,
  RuntimeEventRow,
  RuntimeLogLineRow,
} from "@firegrid/protocol/launch"
import {
  asRuntimeContextError,
  mapRuntimeContextError,
  RuntimeContextError,
} from "@firegrid/runtime/errors"
import {
  AcpSessionLive,
  AgentCodecError,
  AgentSession,
  StdioJsonlSessionLive,
} from "@firegrid/runtime/codecs"
import {
  AgentInputEventSchema,
  encodeRuntimeAgentOutputEnvelope,
  type AgentOutputEvent,
} from "@firegrid/runtime/events"
import {
  type AgentByteStream,
  commandForContext,
  RuntimeEnvResolverPolicy,
  SandboxStdinEmissionClaim,
  type SandboxProvider,
  type SandboxProviderError,
} from "@firegrid/runtime/sources/sandbox"
import { SandboxProvider as SandboxProviderTag } from "@firegrid/runtime/sources/sandbox"
import {
  Clock,
  Effect,
  Layer,
  Match,
  Option,
  Ref,
  Schema,
  type Scope,
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
import {
  runtimeContextSessionOwnerSessionId,
} from "./raw-adapter.ts"

interface CodecRuntimeContextSession {
  readonly context: RuntimeContext
  readonly activityAttempt: number
  readonly ownerSessionId: string
  readonly agentSession: AgentSession["Type"]
}

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map(millis => new Date(millis).toISOString()),
)

const codecSessionKey = (
  context: RuntimeContext,
  activityAttempt: number,
) => `${context.contextId}:${activityAttempt}`

const protocolForContext = (
  context: RuntimeContext,
): Exclude<RuntimeAgentProtocol, "raw"> =>
  context.runtime.config.agentProtocol === "acp" ? "acp" : "stdio-jsonl"

const startedEvidence = (
  context: RuntimeContext,
  activityAttempt: number,
): RuntimeContextSessionStartedEvidence => ({
  contextId: context.contextId,
  activityAttempt,
  ownerKind: "codec",
  ownerSessionId: runtimeContextSessionOwnerSessionId("codec", context, activityAttempt),
  startCommandId: `start-${context.contextId}-${activityAttempt}`,
})

const acceptedCommand = (
  session: CodecRuntimeContextSession,
  command: RuntimeContextSessionCommand,
): RuntimeContextSessionCommandAccepted => ({
  contextId: session.context.contextId,
  activityAttempt: session.activityAttempt,
  commandId: command.commandId,
  ownerSessionId: session.ownerSessionId,
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

const runCodecStderrJournal = (
  context: RuntimeContext,
  activityAttempt: number,
  bytes: AgentByteStream,
  writer: PerContextRuntimeOutputWriter["Type"],
) =>
  Effect.gen(function* () {
    const sequenceRef = yield* Ref.make(0)
    yield* codecStderrLines(context.contextId, bytes.stderr).pipe(
      Stream.mapEffect(line =>
        Effect.gen(function* () {
          const sequence = yield* Ref.getAndUpdate(sequenceRef, value => value + 1)
          const receivedAt = yield* nowIso
          yield* writer.appendLogLine(context, logLineRowFromCodecStderr({
            context,
            activityAttempt,
            sequence,
            raw: line,
            receivedAt,
          })).pipe(
            mapRuntimeContextError(
              "runtime-output.codec.stderr.write",
              "failed to write codec stderr runtime log row",
              context.contextId,
            ),
          )
        })),
      Stream.runDrain,
    )
  })

const codecLayerForProtocol = (
  bytes: AgentByteStream,
  context: RuntimeContext,
  protocol: Exclude<RuntimeAgentProtocol, "raw">,
): Layer.Layer<AgentSession, AgentCodecError> =>
  Match.value(protocol).pipe(
    Match.when("stdio-jsonl", () => StdioJsonlSessionLive(bytes)),
    Match.when("acp", () =>
      AcpSessionLive(bytes, {
        ...(context.runtime.config.cwd === undefined ? {} : { cwd: context.runtime.config.cwd }),
        ...(context.runtime.config.mcpServers === undefined ? {} : {
          mcpServers: context.runtime.config.mcpServers.map(declaration => ({
            name: declaration.name,
            server: {
              type: "url" as const,
              url: declaration.server.url,
              ...(declaration.server.headers === undefined ? {} : {
                headers: Object.entries(declaration.server.headers).map(([name, value]) => ({
                  name,
                  value,
                })),
              }),
            },
          })),
        }),
      }).pipe(
        Layer.provide(Layer.succeed(IdGenerator.IdGenerator, IdGenerator.defaultIdGenerator)),
      )),
    Match.exhaustive,
  )

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

const openByteStream = (
  context: RuntimeContext,
): Effect.Effect<AgentByteStream, RuntimeContextError, SandboxProvider | RuntimeEnvResolverPolicy | Scope.Scope> =>
  Effect.gen(function* () {
    const command = yield* commandForContext(context)
    const provider = yield* SandboxProviderTag
    const sandbox = yield* provider.getOrCreate({
      labels: {
        firegridRuntimeContextId: context.contextId,
      },
      ...(context.runtime.config.cwd === undefined ? {} : {
        workingDir: context.runtime.config.cwd,
      }),
      providerConfig: {
        contextId: context.contextId,
      },
    }).pipe(mapSandboxProviderError(context.contextId))
    return yield* provider.openBytePipe(sandbox, command).pipe(
      mapSandboxProviderError(context.contextId),
    )
  })

export const CodecRuntimeContextWorkflowSessionLive: Layer.Layer<
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
    const sessions = yield* Ref.make(new Map<string, CodecRuntimeContextSession>())

    const startOrAttach = (
      context: RuntimeContext,
      activityAttempt: number,
    ): Effect.Effect<RuntimeContextSessionStartedEvidence, RuntimeContextError> =>
      Effect.scoped(
        Effect.gen(function* () {
          const key = codecSessionKey(context, activityAttempt)
          const current = yield* Ref.get(sessions)
          if (current.has(key)) return startedEvidence(context, activityAttempt)

          const bytes = yield* openByteStream(context).pipe(Effect.provide(captured))
          const protocol = protocolForContext(context)
          const agentSession = yield* AgentSession.pipe(
            Effect.provide(codecLayerForProtocol(bytes, context, protocol)),
            Effect.mapError(cause =>
              asRuntimeContextError(
                `agent-codec.${cause.op}`,
                cause.message,
                context.contextId,
                cause,
              )),
          )
          const session: CodecRuntimeContextSession = {
            context,
            activityAttempt,
            ownerSessionId: runtimeContextSessionOwnerSessionId("codec", context, activityAttempt),
            agentSession,
          }
          yield* Ref.update(sessions, map => new Map([...map, [key, session]]))
          yield* runCodecStderrJournal(context, activityAttempt, bytes, writer).pipe(
            Effect.catchAll(cause =>
              Effect.logWarning("[host-sdk] codec stderr journal failed").pipe(
                Effect.annotateLogs({ contextId: context.contextId, cause }),
              )),
            Effect.forkIn(scope),
          )
          yield* agentSession.outputs.pipe(
            Stream.mapError(cause =>
              asRuntimeContextError(
                `agent-codec.${cause.op}`,
                cause.message,
                context.contextId,
                cause,
              )),
            Stream.mapAccum(0, (sequence, event) => [
              sequence + 1,
              { sequence, event },
            ] as const),
            Stream.mapEffect(({ sequence, event }) =>
              outputRowFromAgentEvent(context, activityAttempt, sequence, event).pipe(
                Effect.flatMap(row => writer.appendEventRow(context, row)),
                Effect.as(event),
              )),
            Stream.takeUntil(event => event._tag === "Terminated"),
            Stream.runDrain,
            Effect.catchAll(cause =>
              Effect.logError("[host-sdk] codec runtime session failed").pipe(
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
        }),
      )

    const getOrStart = (
      context: RuntimeContext,
      activityAttempt: number,
    ) =>
      Effect.gen(function* () {
        yield* startOrAttach(context, activityAttempt)
        const session = (yield* Ref.get(sessions)).get(codecSessionKey(context, activityAttempt))
        if (session === undefined) {
          return yield* Effect.fail(asRuntimeContextError(
            "runtime-context.codec-session.attach",
            "codec runtime session did not attach",
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
        const encoded = yield* Schema.encode(AgentInputEventSchema)(command.event).pipe(
          Effect.map(bytes => new TextEncoder().encode(JSON.stringify(bytes))),
          Effect.mapError(cause =>
            asRuntimeContextError(
              "runtime-context.codec-session.command.encode",
              "failed to encode codec input command",
              context.contextId,
              cause,
            )),
        )
        const claimed = yield* stdinClaim.claim({
          commandId: command.commandId,
          contextId: context.contextId,
          inputId: command.commandId,
          byteLength: encoded.byteLength,
        }).pipe(
          mapRuntimeContextError(
            "runtime-context.codec-session.claim",
            "failed to claim codec runtime input command",
            context.contextId,
          ),
        )
        if (claimed) {
          yield* session.agentSession.send(command.event).pipe(
            Effect.mapError(cause =>
              asRuntimeContextError(
                `agent-codec.${cause.op}`,
                cause.message,
                context.contextId,
                cause,
              )),
          )
        }
        return acceptedCommand(session, command)
      })

    return RuntimeContextWorkflowSession.of({
      startOrAttach,
      send,
    })
  }),
)
