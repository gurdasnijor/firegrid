import type { ScenarioDefinition } from "./definition.ts"
import { directStateClockReceiverScenario } from "./receivers/direct-state-clock-receiver.ts"

const scenarios = [
  directStateClockReceiverScenario,
] as const satisfies ReadonlyArray<ScenarioDefinition>

const scenarioRegistry = new Map<string, ScenarioDefinition>(
  scenarios.map((scenario) => [scenario.name, scenario]),
)

export const listScenarioNames = (): ReadonlyArray<string> =>
  Array.from(scenarioRegistry.keys()).sort()

export const getScenario = (name: string): ScenarioDefinition | undefined =>
  scenarioRegistry.get(name)
