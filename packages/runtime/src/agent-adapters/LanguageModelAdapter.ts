import { LanguageModel } from "@effect/ai"
import { Effect, Layer } from "effect"
import {
  AgentAdapter,
  type AgentAdapterCapabilities,
  type AgentAdapterService,
} from "./AgentAdapter.ts"

export const LanguageModelAdapterCapabilities = {
  streamingText: true,
  tools: true,
  multiTurn: false,
  mayRequestPermissions: false,
} satisfies AgentAdapterCapabilities

export const makeLanguageModelAdapter = (
  languageModel: LanguageModel.Service,
): AgentAdapterService => ({
  // firegrid-effect-ai-native-agents.LANGUAGE_MODEL_ADAPTER.2
  capabilities: LanguageModelAdapterCapabilities,
  // firegrid-effect-ai-native-agents.LANGUAGE_MODEL_ADAPTER.1
  // firegrid-effect-ai-native-agents.ADAPTER_ERRORS.2
  languageModel,
})

export const LanguageModelAdapter = {
  // firegrid-effect-ai-native-agents.ADAPTER_SURFACE.2
  layer: (): Layer.Layer<AgentAdapter, never, LanguageModel.LanguageModel> =>
    Layer.effect(
      AgentAdapter,
      Effect.map(
        LanguageModel.LanguageModel,
        languageModel => makeLanguageModelAdapter(languageModel),
      ),
    ),
} as const
