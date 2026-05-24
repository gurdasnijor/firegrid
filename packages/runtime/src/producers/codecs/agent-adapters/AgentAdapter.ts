import type { LanguageModel } from "@effect/ai"
import type { RuntimeContext } from "@firegrid/protocol/launch"
import { Context, type Effect, Layer } from "effect"
import type { AgentAdapterSelectionError } from "./errors.ts"

export interface AgentAdapterCapabilities {
  readonly streamingText: boolean
  readonly tools: boolean
  readonly multiTurn: boolean
  readonly mayRequestPermissions: boolean
}

export interface AgentAdapterService {
  readonly capabilities: AgentAdapterCapabilities
  // firegrid-effect-ai-native-agents.ADAPTER_SURFACE.1
  // firegrid-effect-ai-native-agents.ADAPTER_ERRORS.2
  readonly languageModel: LanguageModel.Service
}

// firegrid-effect-ai-native-agents.ADAPTER_SURFACE.1
// firegrid-effect-ai-native-agents.ADAPTER_SURFACE.2
export class AgentAdapter extends Context.Tag(
  "firegrid/agent-adapters/AgentAdapter",
)<AgentAdapter, AgentAdapterService>() {
  static layer = (
    service: AgentAdapterService,
  ): Layer.Layer<AgentAdapter> => Layer.succeed(this, service)
}

export interface AgentAdapterRegistryService {
  readonly adapterFor: (
    context: RuntimeContext,
  ) => Effect.Effect<AgentAdapterService, AgentAdapterSelectionError>
}

// firegrid-effect-ai-native-agents.ADAPTER_SURFACE.3
export class AgentAdapterRegistry extends Context.Tag(
  "firegrid/agent-adapters/AgentAdapterRegistry",
)<AgentAdapterRegistry, AgentAdapterRegistryService>() {
  static layer = (
    service: AgentAdapterRegistryService,
  ): Layer.Layer<AgentAdapterRegistry> => Layer.succeed(this, service)
}
