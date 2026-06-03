import { IdGenerator, McpServer, Prompt } from "@effect/ai"
import { WorkflowEngine } from "@effect/workflow"
import type { PermissionDecision } from "@firegrid/protocol/agent-tools"
import {
  EventOffsetSchema,
  HostPermissionRespondChannel,
  SessionAgentOutputChannel,
  SessionAgentOutputChannelTarget,
  SessionPromptChannel,
  SessionPromptChannelTarget,
  eventOffset,
  makeDurableEventChannel,
  makeIngressChannel,
  type DurableEventChannel,
} from "@firegrid/protocol/channels"
import {
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  runtimeContextsView,
  runtimeEventsForContextView,
} from "@firegrid/protocol/launch"
import { firegridProjection } from "@firegrid/protocol/projection"
import {
  RuntimeAgentOutputObservationSchema,
  runtimeAgentOutputObservationFromRow,
} from "@firegrid/protocol/session-facade"
import { AgentInputEventSchema, type AgentInputEvent } from "@firegrid/runtime/events"
import { RuntimeEnvResolverPolicy } from "@firegrid/runtime/sources/sandbox"
import { AcpContextRows } from "@firegrid/runtime/sources/codecs/acp/stdio-edge"
import { HostPlaneSessionControlRouterLive } from "@firegrid/runtime/channels"
import {
  ContextResolverTag,
  defaultProductionAdapterLayer,
  DurableStreamsLive,
  FiregridAgentToolContext,
  FiregridAgentToolkit,
  FiregridAgentToolkitLayer,
  FiregridRuntime,
  RuntimeContextSessionWorkflow,
  ToolDispatchLive,
  type SessionInputPayload,
} from "@firegrid/runtime/unified"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import type {
  FiregridHost,
  TinyFiregridHostEnv,
} from "../../types.ts"
import {
  makeMcpTaskProjectionProtocolLayer,
  runMcpServerLayer,
} from "./protocol.ts"
import { createWireStreams } from "./wire.ts"

const DEFAULT_ATTEMPT = 1

const gatewayContextId = "session:tiny-firegrid:mcp-task-projection-parent"

const sessionPromptProjection = {
  operationId: "session.prompt",
  toolName: "session_prompt",
  clientName: "sessions.prompt",
  cliName: "sessions prompt",
} as const

const SessionHandlePromptInputSchema = Schema.Struct({
  payload: Schema.Unknown,
  inputId: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  idempotencyKey: Schema.String.pipe(Schema.minLength(1)),
  metadata: Schema.optional(Schema.Record({
    key: Schema.String,
    value: Schema.String,
  })),
}).annotations({
  identifier: "firegrid.operation.session.promptScoped.input",
  title: "Scoped session prompt input",
  description:
    "Append a prompt to a RuntimeContext-backed session without restating the context id.",
  ...firegridProjection({
    operationId: "session.prompt.scoped",
    clientName: "session.prompt",
  }),
  parseOptions: {
    onExcessProperty: "error",
  },
})

const sessionPromptOperation = {
  operationId: sessionPromptProjection.operationId,
  projection: sessionPromptProjection,
  scopedInput: SessionHandlePromptInputSchema,
  scopedOutput: EventOffsetSchema,
  lowering: {
    family: "durable-event",
    primitive: "append-session-input",
    durable: true,
    sessionScoped: true,
  },
  channel: {
    target: SessionPromptChannelTarget,
    verb: "send",
    kind: "egress",
    durable: true,
  },
} as const

type GeneratedSessionHandlePromptInput = Schema.Schema.Type<
  typeof sessionPromptOperation.scopedInput
>

const encodeAgentInputEvent = Schema.encodeSync(AgentInputEventSchema)

const encodePromptPayload = (
  payload: unknown,
  correlationId: string,
): SessionInputPayload => {
  const text =
    typeof payload === "object" &&
      payload !== null &&
      "text" in payload &&
      typeof payload.text === "string"
      ? payload.text
      : typeof payload === "string"
      ? payload
      : JSON.stringify(payload)

  const event: AgentInputEvent = {
    _tag: "Prompt",
    prompt: Prompt.userMessage({
      content: [Prompt.textPart({ text })],
    }),
    correlationId,
  }

  return {
    kind: "prompt",
    payloadJson: JSON.stringify(encodeAgentInputEvent(event)),
  }
}

const dispatchGeneratedSessionPrompt = (
  contextId: string,
  request: GeneratedSessionHandlePromptInput,
): Effect.Effect<Schema.Schema.Type<typeof EventOffsetSchema>, unknown, WorkflowEngine.WorkflowEngine> =>
  Effect.gen(function*() {
    const correlationId = request.idempotencyKey
    const input = encodePromptPayload(request.payload, correlationId)
    const executionId = yield* RuntimeContextSessionWorkflow.execute({
      contextId,
      attempt: DEFAULT_ATTEMPT,
      inputKey: correlationId,
      input,
    }, { discard: true })

    return eventOffset(
      `${String(sessionPromptOperation.channel.target)}:${executionId}|${correlationId}`,
    )
  }).pipe(
    Effect.withSpan("tiny_firegrid.mcp_task_projection.generated_session_prompt.append", {
      attributes: {
        "firegrid.operation.id": sessionPromptOperation.operationId,
        "firegrid.projection.tool_name": sessionPromptOperation.projection.toolName,
        "firegrid.projection.client_name": sessionPromptOperation.projection.clientName,
        "firegrid.projection.cli_name": sessionPromptOperation.projection.cliName,
        "firegrid.channel.target": String(sessionPromptOperation.channel.target),
        "firegrid.channel.verb": sessionPromptOperation.channel.verb,
        "firegrid.channel.kind": sessionPromptOperation.channel.kind,
        "firegrid.channel.durable": sessionPromptOperation.channel.durable,
        "firegrid.operation.lowering.family": sessionPromptOperation.lowering.family,
        "firegrid.operation.lowering.primitive": sessionPromptOperation.lowering.primitive,
        "firegrid.operation.lowering.session_scoped": sessionPromptOperation.lowering.sessionScoped,
      },
    }),
  )

const makeGeneratedSessionPromptChannel = (
  engine: WorkflowEngine.WorkflowEngine["Type"],
  sessionId: string,
): DurableEventChannel<typeof sessionPromptOperation.scopedInput> =>
  makeDurableEventChannel({
    target: sessionPromptOperation.channel.target,
    schema: sessionPromptOperation.scopedInput,
    append: request =>
      dispatchGeneratedSessionPrompt(sessionId, request).pipe(
        Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
      ),
  })

const GeneratedSessionPromptChannelLive = Layer.effect(
  SessionPromptChannel,
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine
    return SessionPromptChannel.of({
      forSession: sessionId => makeGeneratedSessionPromptChannel(engine, sessionId),
    })
  }),
)

const ContextResolverFromControlPlaneTableLive = Layer.effect(
  ContextResolverTag,
  Effect.gen(function*() {
    const control = yield* RuntimeControlPlaneTable
    return {
      resolve: (contextId: string) => control.contexts.get(contextId),
    }
  }),
)

const GatewayToolContextLive = Layer.effect(
  FiregridAgentToolContext,
  Effect.gen(function*() {
    const resolver = yield* ContextResolverTag
    return FiregridAgentToolContext.of({
      resolve: Effect.gen(function*() {
        const runtimeContext = yield* resolver.resolve(gatewayContextId).pipe(
          Effect.flatMap(Option.match({
            onNone: () => Effect.fail(new Error(`gateway context not found: ${gatewayContextId}`)),
            onSome: Effect.succeed,
          })),
        )
        yield* Effect.annotateCurrentSpan({
          "firegrid.context.id": gatewayContextId,
        })
        return { contextId: gatewayContextId, runtimeContext }
      }),
    })
  }),
)

const GlobalSessionAgentOutputChannelLive = Layer.effect(
  SessionAgentOutputChannel,
  RuntimeOutputTable.pipe(
    Effect.map(output =>
      SessionAgentOutputChannel.of({
        forContext: contextId =>
          makeIngressChannel({
            target: SessionAgentOutputChannelTarget,
            schema: RuntimeAgentOutputObservationSchema,
            sourceClass: "static-source",
            stream: runtimeEventsForContextView(output.events.rows(), contextId).pipe(
              Stream.filterMap(runtimeAgentOutputObservationFromRow),
            ),
          }),
      })),
  ),
)

// Required by the claude ACP edge. It is host-owned read composition, not a
// driver/client read path.
const AcpContextRowsLive = Layer.effect(
  AcpContextRows,
  RuntimeControlPlaneTable.pipe(
    Effect.map(control => runtimeContextsView(control.contexts.rows())),
  ),
)

const registerToolkitLayer = Layer.scopedDiscard(
  Effect.gen(function*() {
    yield* McpServer.registerToolkit(FiregridAgentToolkit)
  }).pipe(
    Effect.withSpan("tiny_firegrid.mcp_task_projection.register_toolkit", {
      attributes: {
        "firegrid.mcp.tool_profile": "full",
      },
    }),
  ),
).pipe(
  Layer.provide(FiregridAgentToolkitLayer),
  Layer.provide(GatewayToolContextLive),
  Layer.provide(Layer.succeed(IdGenerator.IdGenerator, IdGenerator.defaultIdGenerator)),
)

const McpTaskProjectionServerLive = (
  env: TinyFiregridHostEnv,
) =>
  Layer.unwrapEffect(
    Effect.gen(function*() {
      const wire = {
        baseUrl: env.durableStreamsBaseUrl,
        namespace: env.namespace,
        streamId: env.simulationId,
      }
      yield* createWireStreams(wire)
      const sessionAgentOutput = yield* SessionAgentOutputChannel
      const permissionRespond = yield* HostPermissionRespondChannel
      const output = yield* RuntimeOutputTable
      return registerToolkitLayer.pipe(
        Layer.provide(runMcpServerLayer),
        Layer.provide(makeMcpTaskProjectionProtocolLayer(
          wire,
          {
            outputSnapshot: contextId =>
              Effect.sync(() =>
                runtimeEventsForContextView(
                  Stream.fromIterable(output.events.collection.toArray),
                  contextId,
                ).pipe(
                  Stream.filterMap(runtimeAgentOutputObservationFromRow),
                )).pipe(
                  Effect.flatMap(stream =>
                    stream.pipe(
                      Stream.runCollect,
                      Effect.map(chunk => Array.from(chunk)),
                    )),
                ),
            outputStream: contextId =>
              sessionAgentOutput.forContext(contextId).binding.stream,
            permissionRespondAppend: request =>
              permissionRespond.binding.append({
                contextId: request.contextId,
                permissionRequestId: request.permissionRequestId,
                decision: request.decision as PermissionDecision,
                idempotencyKey: request.idempotencyKey,
              }),
            restartIngress: Effect.annotateCurrentSpan({
              "firegrid.mcp_task_projection.host_bounce": "stateless-protocol-restart-point",
              "firegrid.mcp_task_projection.rehydration_source": "self_describing_task_id_plus_runtime_output",
            }),
          },
        )),
      )
    }),
  )

export const mcpTaskProjectionGatewayHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown> => {
  const runtime = FiregridRuntime(
    {
      namespace: env.namespace,
    },
    defaultProductionAdapterLayer(
      RuntimeEnvResolverPolicy.withPolicy({
        authorizedBindings: [
          ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"],
        ],
        lookupEnv: name => env.processEnv[name],
      }),
    ),
  ).pipe(
    Layer.provide(
      DurableStreamsLive.configuredWith({
        baseUrl: env.durableStreamsBaseUrl,
        namespace: env.namespace,
      }),
    ),
  )

  const support = Layer.mergeAll(
    ContextResolverFromControlPlaneTableLive,
    GlobalSessionAgentOutputChannelLive,
    AcpContextRowsLive,
  )

  return Layer.mergeAll(
    GeneratedSessionPromptChannelLive,
    McpTaskProjectionServerLive(env),
  ).pipe(
    Layer.provideMerge(ToolDispatchLive),
    Layer.provideMerge(HostPlaneSessionControlRouterLive),
    Layer.provideMerge(support),
    Layer.provideMerge(runtime),
  )
}
