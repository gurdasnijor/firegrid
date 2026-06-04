import { Prompt } from "@effect/ai"
import { WorkflowEngine } from "@effect/workflow"
import { firegridHost } from "@firegrid/host-sdk"
import {
  EventOffsetSchema,
  SessionPromptChannel,
  SessionPromptChannelTarget,
  eventOffset,
  makeDurableEventChannel,
  type DurableEventChannel,
} from "@firegrid/protocol/channels"
import { DurableStreamsLive, local } from "@firegrid/protocol/launch"
import { firegridProjection } from "@firegrid/protocol/projection"
import { AgentInputEventSchema, type AgentInputEvent } from "@firegrid/runtime/events"
import { RuntimeEnvResolverPolicy } from "@firegrid/runtime/sources/sandbox"
import {
  defaultProductionAdapterLayer,
  RuntimeContextSessionWorkflow,
  type SessionInputPayload,
} from "@firegrid/runtime/unified"
import { Effect, Layer, Schema } from "effect"
import type {
  FiregridHost,
  TinyFiregridHostEnv,
} from "../../types.ts"

const DEFAULT_ATTEMPT = 1

const sessionPromptProjection = {
  operationId: "session.prompt",
  toolName: "session_prompt",
  clientName: "sessions.prompt",
  cliName: "sessions prompt",
} as const

const SessionPromptToolInputSchema = Schema.Struct({
  sessionId: Schema.String.pipe(Schema.minLength(1)),
  prompt: Schema.String.pipe(Schema.minLength(1)),
  inputId: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  metadata: Schema.optional(Schema.Record({
    key: Schema.String,
    value: Schema.String,
  })),
}).annotations({
  identifier: "firegrid.agentTool.session_prompt.input",
  title: "Session-prompt tool input",
  description:
    "Append a prompt to an existing RuntimeContext-backed session via host-owned ingress.",
  examples: [{
    sessionId: "ctx_example",
    prompt: "Continue with the accepted plan.",
  }],
  ...firegridProjection(sessionPromptProjection),
  parseOptions: {
    onExcessProperty: "error",
  },
})

const SessionPromptToolOutputSchema = Schema.Struct({
  appended: Schema.Literal(true),
  sessionId: Schema.String.pipe(Schema.minLength(1)),
  inputId: Schema.String.pipe(Schema.minLength(1)),
}).annotations({
  identifier: "firegrid.agentTool.session_prompt.output",
  title: "Session-prompt tool output",
})

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
  input: SessionPromptToolInputSchema,
  output: SessionPromptToolOutputSchema,
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
    Effect.withSpan("tiny_firegrid.op_registry_prompt.generated_session_prompt.append", {
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

const claudeAcpArgv = [
  "npx",
  "-y",
  "@agentclientprotocol/claude-agent-acp@0.36.1",
] as const

export const opRegistryPromptKeystoneHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown> =>
  GeneratedSessionPromptChannelLive.pipe(
    Layer.provideMerge(
      firegridHost({
        spec: { namespace: env.namespace },
        adapter: defaultProductionAdapterLayer(
          RuntimeEnvResolverPolicy.withPolicy({
            authorizedBindings: [
              ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"],
            ],
            lookupEnv: name => env.processEnv[name],
          }),
        ),
        backend: DurableStreamsLive.configuredWith({
          baseUrl: env.durableStreamsBaseUrl,
          namespace: env.namespace,
        }),
        ingress: {
          transport: "durable-streams",
          baseUrl: env.durableStreamsBaseUrl,
          namespace: env.namespace,
          streamId: "op-registry-prompt-keystone",
          gatewayExternalKey: {
            source: "tiny-firegrid",
            id: "op-registry-prompt-keystone-gateway",
          },
          gatewayRuntime: local.jsonl({
            argv: [...claudeAcpArgv],
            agent: "claude-acp",
            agentProtocol: "acp",
            cwd: globalThis.process.cwd(),
            envBindings: [
              { name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" },
            ],
          }),
        },
      }),
    ),
  )
