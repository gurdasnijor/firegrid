import { IdGenerator } from "@effect/ai"
import type {
  RuntimeAgentProtocol,
  RuntimeContext,
  RuntimeLogLineRow,
} from "@firegrid/protocol/launch"
import {
  asRuntimeContextError,
  mapRuntimeContextError,
  type RuntimeContextError,
} from "@firegrid/runtime/errors"
import {
  AcpSessionLive,
  AgentSession,
  StdioJsonlSessionLive,
  type AgentCodecError,
} from "@firegrid/runtime/codecs"
import {
  AgentInputEventSchema,
} from "@firegrid/runtime/events"
import {
  type AgentByteStream,
  commandForContext,
  type RuntimeEnvResolverPolicy,
  type SandboxProvider,
  type SandboxProviderError,
} from "@firegrid/runtime/sources/sandbox"
import { SandboxProvider as SandboxProviderTag } from "@firegrid/runtime/sources/sandbox"
import {
  Clock,
  Context,
  Effect,
  Layer,
  Match,
  Ref,
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
import * as SessionCommon from "./common.ts"

interface CodecRuntimeContextSession extends SessionCommon.RuntimeContextSessionRecord {
  readonly agentSession: AgentSession["Type"]
}

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map(millis => new Date(millis).toISOString()),
)

const protocolForContext = (
  context: RuntimeContext,
): Exclude<RuntimeAgentProtocol, "raw"> =>
  context.runtime.config.agentProtocol === "acp" ? "acp" : "stdio-jsonl"

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

export const makeCodecRuntimeContextWorkflowSessionService:
  Effect.Effect<
    RuntimeContextWorkflowSessionService,
    never,
    SessionCommon.RuntimeContextSessionAdapterRequirements
  > =
  SessionCommon.makeRuntimeContextSessionAdapterService<CodecRuntimeContextSession>((deps) => {
    const startSession = (
      context: RuntimeContext,
      activityAttempt: number,
      key: string,
    ): Effect.Effect<CodecRuntimeContextSession, RuntimeContextError> =>
        Effect.gen(function* () {
          const bytes = yield* Scope.extend(
            openByteStream(context).pipe(Effect.provide(deps.captured)),
            deps.scope,
          )
          const protocol = protocolForContext(context)
          const sessionContext = yield* Layer.buildWithScope(
            codecLayerForProtocol(bytes, context, protocol),
            deps.scope,
          ).pipe(
            Effect.mapError(cause =>
              asRuntimeContextError(
                `agent-codec.${cause.op}`,
                cause.message,
                context.contextId,
                cause,
              )),
          )
          const agentSession = Context.get(sessionContext, AgentSession)
          const session: CodecRuntimeContextSession = {
            context,
            activityAttempt,
              ownerSessionId: SessionCommon.runtimeContextSessionOwnerSessionId("codec", context, activityAttempt),
            agentSession,
          }
          yield* runCodecStderrJournal(context, activityAttempt, bytes, deps.writer).pipe(
            Effect.catchAll(cause =>
              Effect.logWarning("[host-sdk] codec stderr journal failed").pipe(
                Effect.annotateLogs({ contextId: context.contextId, cause }),
              )),
            Effect.forkIn(deps.scope),
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
              deps.writer.appendAgentEvent(context, activityAttempt, sequence, event).pipe(
                mapRuntimeContextError(
                  "runtime-output.codec.write",
                  "failed to write codec runtime output row",
                  context.contextId,
                ),
                Effect.as(event),
              )),
            Stream.takeUntil(event => event._tag === "Terminated"),
            Stream.runDrain,
            Effect.catchAll(cause =>
              Effect.logError("[host-sdk] codec runtime session failed").pipe(
                Effect.annotateLogs({ contextId: context.contextId, cause }),
              )),
            Effect.ensuring(SessionCommon.removeRuntimeContextSession(deps.sessions, key)),
            Effect.forkIn(deps.scope),
          )
          return session
        })

    const sendCommand = SessionCommon.makeRuntimeContextSessionCommandSender<CodecRuntimeContextSession>({
      ownerKind: "codec",
      stdinClaim: deps.stdinClaim,
      prepare: (context, session, command) =>
        Effect.gen(function* () {
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
          return {
            byteLength: encoded.byteLength,
            emit: session.agentSession.send(command.event).pipe(
              Effect.mapError(cause =>
                asRuntimeContextError(
                  `agent-codec.${cause.op}`,
                  cause.message,
                  context.contextId,
                  cause,
                )),
            ),
          }
        }),
    })

    return SessionCommon.makeRuntimeContextWorkflowSessionService({
      ownerKind: "codec",
      sessions: deps.sessions,
      startSession,
      sendCommand,
    })
  })

export const CodecRuntimeContextWorkflowSessionLive = SessionCommon.scopedRuntimeContextWorkflowSessionLayer(
  makeCodecRuntimeContextWorkflowSessionService,
)
