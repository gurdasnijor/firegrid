import { IdGenerator } from "@effect/ai"
import { WorkflowEngine } from "@effect/workflow"
import {
  firegridRuntimeContextMcpDeclaration,
  type McpServerDeclaration,
  type RuntimeAgentProtocol,
  type RuntimeContext,
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
  runCodecRuntimeContextStderrJournal,
} from "@firegrid/runtime/session-byte-stream-adapter"
import {
  type AgentByteStream,
} from "@firegrid/runtime/sources/sandbox"
import {
  Context,
  Effect,
  Layer,
  Match,
  Option,
  Schema,
  Scope,
  Stream,
} from "effect"
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

const protocolForContext = (
  context: RuntimeContext,
): Exclude<RuntimeAgentProtocol, "raw"> =>
  context.runtime.config.agentProtocol === "acp" ? "acp" : "stdio-jsonl"

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
    Match.when("stdio-jsonl", () =>
      StdioJsonlSessionLive(bytes).pipe(
        Layer.withSpan("firegrid.agent_event_pipeline.codec.layer", {
          attributes: {
            "firegrid.context.id": context.contextId,
            "firegrid.codec.protocol": protocol,
            "firegrid.mcp.server_count": effectiveMcpServers?.length ?? 0,
          },
        }),
        Layer.annotateSpans("firegrid.side", "codec"),
      )),
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
        Layer.withSpan("firegrid.agent_event_pipeline.codec.layer", {
          attributes: {
            "firegrid.context.id": context.contextId,
            "firegrid.codec.protocol": protocol,
            "firegrid.mcp.server_count": effectiveMcpServers?.length ?? 0,
            "firegrid.mcp.server_names": (effectiveMcpServers ?? []).map(server => server.name).join(","),
          },
        }),
        Layer.annotateSpans("firegrid.side", "codec"),
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
// Canonical host-side builder for the concrete contextId-scoped MCP URL
// from the host's OWN bound base. Package-local helper for the codec start path;
// tests assert the observable MCP resolution through resolveEffectiveMcpServers.
const runtimeContextMcpUrlForContext = (
  base: FiregridRuntimeContextMcpBase,
  contextId: string,
): string => {
  const route = runtimeContextMcpPath(base.basePath).replace(
    ":contextId",
    encodeURIComponent(contextId),
  )
  return new URL(route, base.address).toString()
}

// The exact resolution the codec start path uses to honor the URL-less
// `runtimeContextMcp` marker. Exported as the deterministic seam under
// test: given a materialized context + the host's bound MCP base, it
// returns the host-provisioned `firegrid-runtime-context` declaration
// (or fails explicitly when the marker is set but no MCP is bound).
export const resolveEffectiveMcpServers = (
  context: RuntimeContext,
): Effect.Effect<
  ReadonlyArray<McpServerDeclaration> | undefined,
  RuntimeContextError,
  FiregridRuntimeContextMcpBaseUrl
  > =>
  Effect.gen(function* () {
    const declared = context.runtime.config.mcpServers
    if (context.runtime.config.runtimeContextMcp?.enabled !== true) {
      yield* Effect.annotateCurrentSpan({
        "firegrid.context.id": context.contextId,
        "firegrid.runtime_context_mcp.enabled": false,
        "firegrid.mcp.declared_count": declared?.length ?? 0,
      })
      return declared
    }
    const baseService = yield* FiregridRuntimeContextMcpBaseUrl
    const base = yield* baseService.get
    if (Option.isNone(base)) {
      return yield* asRuntimeContextError(
        "agent-codec.runtime-context-mcp.unavailable",
        "runtime intent requires the Firegrid runtime-context MCP server (runtimeContextMcp marker) but this host has no MCP listener bound",
        context.contextId,
      )
    }
    const injected = firegridRuntimeContextMcpDeclaration(
      runtimeContextMcpUrlForContext(base.value, context.contextId),
    )
    yield* Effect.annotateCurrentSpan({
      "firegrid.context.id": context.contextId,
      "firegrid.runtime_context_mcp.enabled": true,
      "firegrid.mcp.bound_address": base.value.address,
      "firegrid.mcp.base_path": base.value.basePath,
      "firegrid.mcp.injected_name": injected.name,
      "firegrid.mcp.injected_url": injected.server.url,
      "firegrid.mcp.declared_count": declared?.length ?? 0,
    })
    return [
      injected,
      ...(declared ?? []).filter(existing => existing.name !== injected.name),
    ]
  }).pipe(
    Effect.withSpan("firegrid.host.codec.resolve_effective_mcp_servers", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": context.contextId,
        "firegrid.runtime_context_mcp.enabled": context.runtime.config.runtimeContextMcp?.enabled === true,
      },
    }),
  )

const startSessionSpanAttributes = (
  context: RuntimeContext,
  activityAttempt: number,
): Record<string, string | number | boolean> => {
  const config = context.runtime.config
  const attributes: Record<string, string | number | boolean> = {}
  attributes["firegrid.context.id"] = context.contextId
  attributes["firegrid.activity_attempt"] = activityAttempt
  attributes["firegrid.runtime.agent"] = config.agent ?? ""
  attributes["firegrid.runtime.agent_protocol"] = config.agentProtocol ?? ""
  attributes["firegrid.runtime_context_mcp.enabled"] = config.runtimeContextMcp?.enabled === true
  return attributes
}

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
          yield* Effect.annotateCurrentSpan(startSessionSpanAttributes(context, activityAttempt))
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
          yield* Effect.annotateCurrentSpan({
            "firegrid.codec.kind": agentSession.meta.kind,
            "firegrid.codec.tools": agentSession.meta.capabilities.tools,
            "firegrid.codec.permissions": agentSession.meta.capabilities.permissions,
            "firegrid.codec.tool_use_mode": agentSession.toolUseMode,
          })
          const session: CodecRuntimeContextSession = {
            context,
            activityAttempt,
              ownerSessionId: SessionCommon.runtimeContextSessionOwnerSessionId("codec", context, activityAttempt),
            agentSession,
          }
          return {
            session,
            run: Effect.gen(function*() {
              yield* runCodecRuntimeContextStderrJournal({
                context,
                activityAttempt,
                bytes,
                writer: deps.writer,
              }).pipe(
                Effect.catchAll(cause =>
                  Effect.logWarning("[host-sdk] codec stderr journal failed").pipe(
                    Effect.annotateLogs({ contextId: context.contextId, cause }),
                  )),
                Effect.forkIn(deps.scope),
              )
              yield* agentSession.outputs.pipe(
                Stream.withSpan("firegrid.agent_event_pipeline.codec.outputs", {
                  attributes: {
                    "firegrid.context.id": context.contextId,
                    "firegrid.activity_attempt": activityAttempt,
                    "firegrid.codec.kind": agentSession.meta.kind,
                  },
                }),
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
                  Effect.gen(function*() {
                    yield* Effect.annotateCurrentSpan({
                      "firegrid.context.id": context.contextId,
                      "firegrid.activity_attempt": activityAttempt,
                      "firegrid.output.sequence": sequence,
                      "firegrid.agent_output.tag": event._tag,
                      ...(event._tag === "ToolUse" ? { "firegrid.agent_output.tool_name": event.part.name } : {}),
                    })
                    return yield* deps.writer.appendAgentEvent(context, activityAttempt, sequence, event).pipe(
                      mapRuntimeContextError(
                        "runtime-output.codec.write",
                        "failed to write codec runtime output row",
                        context.contextId,
                      ),
                      Effect.as(event),
                    )
                  }).pipe(
                    Effect.withSpan("firegrid.agent_event_pipeline.subscriber.runtime_output", {
                      kind: "producer",
                      attributes: {
                        "firegrid.context.id": context.contextId,
                        "firegrid.output.sequence": sequence,
                        "firegrid.agent_output.tag": event._tag,
                      },
                    }),
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
        }).pipe(
          Effect.withSpan("firegrid.host.codec.start_session", {
            kind: "internal",
            attributes: {
              "firegrid.context.id": context.contextId,
              "firegrid.activity_attempt": activityAttempt,
            },
          }),
          Effect.annotateSpans("firegrid.side", "codec"),
        )

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
