import { claimBeforeSideEffectScenario } from "./emitters/claim-before-side-effect.ts"
import { echoScenario } from "./emitters/echo.ts"
import { failingOperationScenario } from "./emitters/failing-operation.ts"
import { firelineShapedScenario } from "./emitters/fireline-shaped.ts"
import { firelineRejectionScenario } from "./emitters/fireline-rejection.ts"
import { scheduledWorkScenario } from "./emitters/scheduled-work.ts"
import { sleepScenario } from "./emitters/sleep.ts"
import { waitForScenario } from "./emitters/wait-for.ts"
import { claimBeforeSideEffectReceiverScenario } from "./receivers/claim-before-side-effect-receiver.ts"
import { echoReceiverScenario } from "./receivers/echo-receiver.ts"
import { failingOperationReceiverScenario } from "./receivers/failing-operation-receiver.ts"
import { firelineShapedReceiverScenario } from "./receivers/fireline-shaped-receiver.ts"
import { firelineRejectionReceiverScenario } from "./receivers/fireline-rejection-receiver.ts"
import { scheduledWorkReceiverScenario } from "./receivers/scheduled-work-receiver.ts"
import { sleepReceiverScenario } from "./receivers/sleep-receiver.ts"
import { waitForReceiverScenario } from "./receivers/wait-for-receiver.ts"
import type { ScenarioDefinition } from "./definition.ts"

const scenarios = [
  claimBeforeSideEffectScenario,
  echoScenario,
  failingOperationScenario,
  firelineShapedScenario,
  firelineRejectionScenario,
  scheduledWorkScenario,
  sleepScenario,
  waitForScenario,
  claimBeforeSideEffectReceiverScenario,
  echoReceiverScenario,
  failingOperationReceiverScenario,
  firelineShapedReceiverScenario,
  firelineRejectionReceiverScenario,
  scheduledWorkReceiverScenario,
  sleepReceiverScenario,
  waitForReceiverScenario,
] as const satisfies ReadonlyArray<ScenarioDefinition>

const scenarioRegistry = new Map<string, ScenarioDefinition>(
  scenarios.map((scenario) => [scenario.name, scenario]),
)

export const listScenarioNames = (): ReadonlyArray<string> =>
  Array.from(scenarioRegistry.keys()).sort()

export const getScenario = (name: string): ScenarioDefinition | undefined =>
  scenarioRegistry.get(name)
