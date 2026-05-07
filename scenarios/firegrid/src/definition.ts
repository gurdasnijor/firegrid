import type { Effect } from "effect"

export interface ReceiverScenarioDefinition {
  readonly kind: "receiver"
  readonly name: string
  readonly run: (
    streamUrl: string,
  ) => Effect.Effect<unknown, unknown, never>
  readonly selfTest?: () => Effect.Effect<unknown, unknown, never>
}

export type ScenarioDefinition = ReceiverScenarioDefinition

export const defineReceiverScenario = (
  definition: ReceiverScenarioDefinition,
): ReceiverScenarioDefinition => Object.freeze(definition)
