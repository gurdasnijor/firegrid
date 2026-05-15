import { LanguageModel, Response } from "@effect/ai"
import {
  local,
  makeHostStreamPrefix,
  normalizeRuntimeIntent,
  type HostId,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import { Chunk, Effect, Layer, Stream } from "effect"
import { describe, expect, it } from "vitest"
import {
  AgentAdapter,
  AgentAdapterRegistry,
  CurrentAgentTurn,
  LanguageModelAdapter,
  PermissionRequiredButNotHandled,
} from "./index.ts"

const promptText = (prompt: unknown): string =>
  typeof prompt === "string" ? prompt : "[structured prompt]"

const fakeLanguageModel = {
  generateText: options =>
    Effect.succeed(
      new LanguageModel.GenerateTextResponse([
        Response.textPart({ text: `generated:${promptText(options.prompt)}` }),
      ]),
    ),
  generateObject: () => Effect.dieMessage("not implemented"),
  streamText: options =>
    Stream.fromIterable([
      Response.textDeltaPart({
        id: "fake-stream",
        delta: `stream:${promptText(options.prompt)}`,
      }),
    ]),
} satisfies LanguageModel.Service

const FakeLanguageModelLive = Layer.succeed(
  LanguageModel.LanguageModel,
  fakeLanguageModel,
)

const AgentAdapterLive = LanguageModelAdapter.layer().pipe(
  Layer.provide(FakeLanguageModelLive),
)

const fakeLanguageModelAdapter = {
  capabilities: {
    streamingText: true,
    tools: true,
    multiTurn: false,
    mayRequestPermissions: false,
  },
  languageModel: fakeLanguageModel,
}

const runtimeContext = (): RuntimeContext => {
  const hostId = "host_adapter_test" as HostId
  return {
    contextId: "ctx_adapter_test",
    createdAt: new Date(0).toISOString(),
    runtime: normalizeRuntimeIntent(local.jsonl({
      argv: ["node", "agent.js"],
    })),
    host: {
      hostId,
      streamPrefix: makeHostStreamPrefix({
        namespace: "agent-adapters-test",
        hostId,
      }),
      boundAtMs: 0,
    },
  }
}

describe("runtime agent-adapters", () => {
  it("firegrid-effect-ai-native-agents.LANGUAGE_MODEL_ADAPTER.1 firegrid-effect-ai-native-agents.LANGUAGE_MODEL_ADAPTER.2 firegrid-effect-ai-native-agents.VALIDATION.1 wraps the injected LanguageModel.Service without SandboxProvider", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* AgentAdapter
        const generated = yield* adapter.languageModel.generateText({
          prompt: "hello",
        })
        const streamed = yield* adapter.languageModel.streamText({
          prompt: "hello",
        }).pipe(Stream.runCollect)
        return {
          capabilities: adapter.capabilities,
          languageModelIsInjected: adapter.languageModel === fakeLanguageModel,
          generatedText: generated.text,
          streamed: Chunk.toArray(streamed),
        }
      }).pipe(Effect.provide(AgentAdapterLive)),
    )

    expect(result.capabilities).toEqual({
      streamingText: true,
      tools: true,
      multiTurn: false,
      mayRequestPermissions: false,
    })
    expect(result.languageModelIsInjected).toBe(true)
    expect(result.generatedText).toBe("generated:hello")
    expect(result.streamed).toEqual([
      Response.textDeltaPart({
        id: "fake-stream",
        delta: "stream:hello",
      }),
    ])
  })

  it("firegrid-effect-ai-native-agents.CURRENT_TURN.1 firegrid-effect-ai-native-agents.CURRENT_TURN.2 firegrid-effect-ai-native-agents.VALIDATION.2 provides adapter-local turn correlation through Effect context", async () => {
    const result = await Effect.runPromise(
      CurrentAgentTurn.pipe(
        Effect.provideService(CurrentAgentTurn, {
          turnId: "turn-1",
          contextId: "ctx-1",
        }),
      ),
    )

    expect(result).toEqual({
      turnId: "turn-1",
      contextId: "ctx-1",
    })
  })

  it("firegrid-effect-ai-native-agents.ADAPTER_SURFACE.3 firegrid-effect-ai-native-agents.VALIDATION.3 defines registry selection without runtime-host integration", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* AgentAdapter
        const registry = yield* AgentAdapterRegistry
        const selected = yield* registry.adapterFor(runtimeContext())
        return {
          sameService: selected === adapter,
          provider: runtimeContext().runtime.provider,
        }
      }).pipe(Effect.provide(Layer.mergeAll(
        AgentAdapterRegistry.layer({
          adapterFor: () => Effect.succeed(fakeLanguageModelAdapter),
        }),
        AgentAdapter.layer(fakeLanguageModelAdapter),
      ))),
    )

    expect(result).toEqual({
      sameService: true,
      provider: "local-process",
    })
  })

  it("firegrid-effect-ai-native-agents.ADAPTER_ERRORS.1 constructs canonical adapter errors as yieldable tagged classes", async () => {
    const result = await Effect.runPromiseExit(
      new PermissionRequiredButNotHandled({
        turnId: "turn-1",
        toolCallId: "tool-1",
        message: "permission required",
      }),
    )

    expect(result._tag).toBe("Failure")
  })
})
