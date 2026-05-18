import { IdGenerator } from "@effect/ai"
import { WorkflowEngine } from "@effect/workflow"
import {
  firegridRuntimeContextMcpDeclaration,
  type McpServerDeclaration,
  type RuntimeAgentProtocol,
  type RuntimeContext,
  type RuntimeLogLineRow,
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
} from "@firegrid/runtime/sources/sandbox"
import {
  Clock,
  Context,
  Effect,
  Layer,
  Match,
  Option,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect"
import type {
  PerContextRuntimeOutputWriter,
} from "../per-context-runtime-output.ts"
import {
  RuntimeContextWorkflowNative,
  type RuntimeContextWorkflowSessionService,
} from "../runtime-context-workflow-core.ts"
import {
  runtimeContextWorkflowExecutionId,
} from "../internal/runtime-context-helpers.ts"
import * as SessionCommon from "./common.ts"
import { runtimeContextMcpPath } from "../mcp-host.ts"
import {
  FiregridRuntimeContextMcpBaseUrl,
  type FiregridRuntimeContextMcpBase,
} from "../runtime-context-mcp-base-url.ts"

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
  // TFIND-048: the host-resolved effective MCP server list. This is the
  // durable client `mcpServers` PLUS, when the URL-less
  // `runtimeContextMcp` marker is set, the host-injected concrete
  // `firegrid-runtime-context` declaration built from the host's OWN
  // bound MCP base. The client never expresses this URL.
  effectiveMcpServers: ReadonlyArray<McpServerDeclaration> | undefined,
): Layer.Layer<AgentSession, AgentCodecError> =>
  Match.value(protocol).pipe(
    Match.when("stdio-jsonl", () => StdioJsonlSessionLive(bytes)),
    Match.when("acp", () =>
      AcpSessionLive(bytes, {
        ...(context.runtime.config.cwd === undefined ? {} : { cwd: context.runtime.config.cwd }),
        ...(effectiveMcpServers === undefined ? {} : {
          mcpServers: effectiveMcpServers.map(declaration => ({
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

// TFIND-048 (SDD_MCP_ROUTE_URL_LIFECYCLE Amendment 1 §A1.2/§A1.3):
// host-side resolution of the effective MCP server list. The URL-less
// `runtimeContextMcp` marker on the materialized intent is honored HERE,
// at start, by injecting the concrete `firegrid-runtime-context`
// declaration built from the host's OWN bound MCP base + the
// materialized `contextId`. This is the single injection site; the CLI
// pre-`createOrLoad` injection was deleted in the same transaction. If
// the marker is set but no MCP listener is bound in this host, this is
// an explicit start failure, never a silent skip.
const buildRuntimeContextMcpUrl = (
  base: FiregridRuntimeContextMcpBase,
  contextId: string,
): string => {
  const route = runtimeContextMcpPath(base.basePath).replace(
    ":contextId",
    encodeURIComponent(contextId),
  )
  return new URL(route, base.address).toString()
}

const resolveEffectiveMcpServers = (
  context: RuntimeContext,
): Effect.Effect<
  ReadonlyArray<McpServerDeclaration> | undefined,
  RuntimeContextError,
  FiregridRuntimeContextMcpBaseUrl
> =>
  Effect.gen(function* () {
    const declared = context.runtime.config.mcpServers
    if (context.runtime.config.runtimeContextMcp?.enabled !== true) {
      return declared
    }
    const baseService = yield* FiregridRuntimeContextMcpBaseUrl
    const base = yield* baseService.get
    if (Option.isNone(base)) {
      return yield* Effect.fail(asRuntimeContextError(
        "agent-codec.runtime-context-mcp.unavailable",
        "runtime intent requires the Firegrid runtime-context MCP server (runtimeContextMcp marker) but this host has no MCP listener bound",
        context.contextId,
      ))
    }
    const injected = firegridRuntimeContextMcpDeclaration(
      buildRuntimeContextMcpUrl(base.value, context.contextId),
    )
    return [
      injected,
      ...(declared ?? []).filter(existing => existing.name !== injected.name),
    ]
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
      _key: string,
    ) =>
        Effect.gen(function* () {
          const bytes = yield* Scope.extend(
            SessionCommon.openRuntimeContextByteStream(context).pipe(Effect.provide(deps.captured)),
            deps.scope,
          )
          const protocol = protocolForContext(context)
          const effectiveMcpServers = yield* resolveEffectiveMcpServers(context).pipe(
            Effect.provide(deps.captured),
          )
          const workflowEngine = yield* Effect.serviceOption(WorkflowEngine.WorkflowEngine)
          const workflowInstance = yield* Effect.serviceOption(WorkflowEngine.WorkflowInstance)
          const instance = Option.getOrElse(workflowInstance, () =>
            WorkflowEngine.WorkflowInstance.initial(
              RuntimeContextWorkflowNative,
              runtimeContextWorkflowExecutionId(context.contextId),
            ))
          const codecLayer = codecLayerForProtocol(bytes, context, protocol, effectiveMcpServers).pipe(
            layer => Option.isSome(workflowEngine)
              ? layer.pipe(Layer.provide(Layer.succeed(WorkflowEngine.WorkflowEngine, workflowEngine.value)))
              : layer,
            layer => layer.pipe(Layer.provide(Layer.succeed(WorkflowEngine.WorkflowInstance, instance))),
          )
          const sessionContext = yield* Layer.buildWithScope(
            codecLayer,
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
          return {
            session,
            run: Effect.gen(function*() {
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
              )
            }),
          }
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
      scope: deps.scope,
      startSession,
      sendCommand,
    })
  })

export const CodecRuntimeContextWorkflowSessionLive = SessionCommon.scopedRuntimeContextWorkflowSessionLayer(
  makeCodecRuntimeContextWorkflowSessionService,
)
