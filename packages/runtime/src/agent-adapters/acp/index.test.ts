import * as acp from "@agentclientprotocol/sdk"
import { AiError, Response } from "@effect/ai"
import {
  Chunk,
  Deferred,
  Effect,
  Exit,
  Stream,
} from "effect"
import { describe, expect, it } from "vitest"
import type { AgentByteStream } from "../../agent-io/index.ts"
import {
  AdapterUnsupportedFeature,
  AgentAdapter,
  PermissionRequiredButNotHandled,
} from "../index.ts"
import { AcpAgentAdapter } from "./index.ts"

interface Harness {
  readonly bytes: AgentByteStream
  readonly agentInput: ReadableStream<Uint8Array>
  readonly agentOutput: WritableStream<Uint8Array>
  readonly exit: Deferred.Deferred<{ readonly exitCode?: number; readonly signal?: string }, unknown>
}

class FixtureAgent implements acp.Agent {
  readonly prompts: Array<acp.PromptRequest> = []
  protected readonly connection: acp.AgentSideConnection

  constructor(connection: acp.AgentSideConnection) {
    this.connection = connection
  }

  async initialize(): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
    }
  }

  async newSession(): Promise<acp.NewSessionResponse> {
    return { sessionId: "session-1" }
  }

  async authenticate(): Promise<acp.AuthenticateResponse> {
    return {}
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    this.prompts.push(params)
    const text = params.prompt[0]?.type === "text" ? params.prompt[0].text : "unsupported"
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: { type: "text", text: `received: ${text}` },
      },
    })
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "lookup",
        kind: "read",
        status: "pending",
        rawInput: { query: text },
      },
    })
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
      },
    })
    return { stopReason: "end_turn" }
  }

  async cancel(): Promise<void> {}
}

class PermissionFixtureAgent extends FixtureAgent {
  override async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    this.prompts.push(params)
    const permission = await this.connection.requestPermission({
      sessionId: params.sessionId,
      toolCall: {
        toolCallId: "tool-permission",
        title: "edit config",
        kind: "edit",
        status: "pending",
      },
      options: [
        { optionId: "allow", kind: "allow_once", name: "Allow once" },
        { optionId: "deny", kind: "reject_once", name: "Deny" },
      ],
    })
    return {
      stopReason: permission.outcome.outcome === "cancelled" ? "cancelled" : "end_turn",
    }
  }
}

const makeHarness = Effect.gen(function*() {
  const runtimeToAgent = new TransformStream<Uint8Array, Uint8Array>()
  const agentToRuntime = new TransformStream<Uint8Array, Uint8Array>()
  const stderr = new TransformStream<Uint8Array, Uint8Array>()
  const exit = yield* Deferred.make<
    { readonly exitCode?: number; readonly signal?: string },
    unknown
  >()
  return {
    bytes: {
      stdin: runtimeToAgent.writable,
      stdout: agentToRuntime.readable,
      stderr: stderr.readable,
      exit: Deferred.await(exit),
    },
    agentInput: runtimeToAgent.readable,
    agentOutput: agentToRuntime.writable,
    exit,
  } satisfies Harness
})

const startAgent = <A extends acp.Agent>(
  harness: Harness,
  makeAgent: (connection: acp.AgentSideConnection) => A,
): A => {
  let agent: A | undefined
  const stream = acp.ndJsonStream(harness.agentOutput, harness.agentInput)
  new acp.AgentSideConnection(connection => {
    agent = makeAgent(connection)
    return agent
  }, stream)
  if (agent === undefined) {
    throw new Error("expected ACP fixture agent to initialize synchronously")
  }
  return agent
}

const runWithAdapter = <A>(
  harness: Harness,
  body: (adapter: AgentAdapter["Type"]) => Effect.Effect<A, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const adapter = yield* AgentAdapter
        return yield* body(adapter)
      }).pipe(Effect.provide(AcpAgentAdapter.layer({ bytes: harness.bytes }))),
    ),
  )

describe("AcpAgentAdapter", () => {
  it("firegrid-effect-ai-native-agents.ACP_ADAPTER.3 firegrid-effect-ai-native-agents.ACP_ADAPTER.4 firegrid-effect-ai-native-agents.VALIDATION.4 emits text-delta, tool-call, and finish parts via streamText", async () => {
    const harness = await Effect.runPromise(makeHarness)
    startAgent(harness, connection => new FixtureAgent(connection))
    const parts = await runWithAdapter(harness, adapter =>
      adapter.languageModel.streamText({ prompt: "hello ACP" }).pipe(
        Stream.runCollect,
        Effect.map(Chunk.toReadonlyArray),
      ))

    expect(parts).toEqual([
      Response.textDeltaPart({
        id: "message-1",
        delta: "received: hello ACP",
      }),
      Response.toolCallPart({
        id: "tool-1",
        name: "lookup",
        params: { query: "hello ACP" },
        providerExecuted: false,
      }),
      Response.finishPart({
        reason: "stop",
        usage: new Response.Usage({
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
        }),
      }),
    ])
  })

  it("firegrid-effect-ai-native-agents.ACP_ADAPTER.7 firegrid-effect-ai-native-agents.VALIDATION.5 generateText collects aggregated text and tool-call parts", async () => {
    const harness = await Effect.runPromise(makeHarness)
    startAgent(harness, connection => new FixtureAgent(connection))
    const response = await runWithAdapter(harness, adapter =>
      adapter.languageModel.generateText({ prompt: "hello generate" }))

    expect(response.text).toBe("received: hello generate")
    const toolCalls = (response.content as ReadonlyArray<{ readonly type: string }>).filter(
      part => part.type === "tool-call",
    )
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]).toMatchObject({
      type: "tool-call",
      id: "tool-1",
      name: "lookup",
    })
    expect(response.finishReason).toBe("stop")
  })

  it("firegrid-effect-ai-native-agents.ACP_ADAPTER.2 firegrid-effect-ai-native-agents.VALIDATION.6 reuses one ACP session across consecutive streamText calls", async () => {
    const harness = await Effect.runPromise(makeHarness)
    const agent = startAgent(harness, connection => new FixtureAgent(connection))
    await runWithAdapter(harness, adapter =>
      Effect.gen(function*() {
        yield* adapter.languageModel.streamText({ prompt: "first" }).pipe(Stream.runDrain)
        yield* adapter.languageModel.streamText({ prompt: "second" }).pipe(Stream.runDrain)
      }))

    expect(agent.prompts.length).toBe(2)
    expect(agent.prompts.map(p => p.sessionId)).toEqual(["session-1", "session-1"])
  })

  it("firegrid-effect-ai-native-agents.ACP_ADAPTER.5 firegrid-effect-ai-native-agents.VALIDATION.7 streamText with a toolkit option fails as unsupported", async () => {
    const harness = await Effect.runPromise(makeHarness)
    startAgent(harness, connection => new FixtureAgent(connection))
    const exit = await runWithAdapter(harness, adapter =>
      adapter.languageModel.streamText({
        prompt: "with toolkit",
        toolkit: {} as never,
      }).pipe(Stream.runDrain, Effect.exit))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = exit.cause._tag === "Fail" ? exit.cause.error : undefined
      expect(error).toBeInstanceOf(AiError.UnknownError)
      if (error instanceof AiError.UnknownError) {
        expect(error.module).toBe("AcpAgentAdapter")
        expect(error.method).toBe("streamText")
        expect(error.cause).toBeInstanceOf(AdapterUnsupportedFeature)
        if (error.cause instanceof AdapterUnsupportedFeature) {
          expect(error.cause.feature).toBe("toolkit")
        }
      }
    }
  })

  it("firegrid-effect-ai-native-agents.ACP_ADAPTER.6 firegrid-effect-ai-native-agents.VALIDATION.8 streamText fails when ACP requests permission without a permission capability", async () => {
    const harness = await Effect.runPromise(makeHarness)
    startAgent(harness, connection => new PermissionFixtureAgent(connection))
    const exit = await runWithAdapter(harness, adapter =>
      adapter.languageModel.streamText({ prompt: "edit config" }).pipe(Stream.runDrain, Effect.exit))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = exit.cause._tag === "Fail" ? exit.cause.error : undefined
      expect(error).toBeInstanceOf(AiError.UnknownError)
      if (error instanceof AiError.UnknownError) {
        expect(error.cause).toBeInstanceOf(PermissionRequiredButNotHandled)
        if (error.cause instanceof PermissionRequiredButNotHandled) {
          expect(error.cause.toolCallId).toBe("tool-permission")
        }
      }
    }
  })

  it("firegrid-effect-ai-native-agents.ACP_ADAPTER.9 does not synthesize a messageId on the ACP PromptRequest when no CurrentAgentTurn is provided", async () => {
    const harness = await Effect.runPromise(makeHarness)
    const agent = startAgent(harness, connection => new FixtureAgent(connection))
    await runWithAdapter(harness, adapter =>
      adapter.languageModel.streamText({ prompt: "hi" }).pipe(Stream.runDrain))

    expect(agent.prompts[0]?.messageId).toBeUndefined()
    expect(agent.prompts[0]?.prompt).toEqual([{ type: "text", text: "hi" }])
  })
})
