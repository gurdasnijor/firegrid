import type { Effect } from "effect"
import type { ScenarioRowsDefinition } from "./scenario.ts"

export interface EmitScenarioDefinition {
  readonly kind: "emit"
  readonly name: string
  readonly rows: ScenarioRowsDefinition
}

export interface ReceiverScenarioDefinition {
  readonly kind: "receiver"
  readonly name: string
  readonly run: (
    streamUrl: string,
  ) => Effect.Effect<unknown, unknown, never>
  readonly selfTest?: () => Effect.Effect<unknown, unknown, never>
  readonly seedRows?: (input: {
    readonly whenMs?: number
  }) => ReadonlyArray<unknown>
}

export type ScenarioDefinition =
  | EmitScenarioDefinition
  | ReceiverScenarioDefinition

export const defineEmitScenario = (
  definition: EmitScenarioDefinition,
): EmitScenarioDefinition => Object.freeze(definition)

export const defineReceiverScenario = (
  definition: ReceiverScenarioDefinition,
): ReceiverScenarioDefinition => Object.freeze(definition)
