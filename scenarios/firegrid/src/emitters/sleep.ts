import { defineEmitScenario } from "../definition.ts"
import {
  Operation,
} from "@firegrid/substrate/descriptors"
import {
  defineScenarioRows,
  makeOperationStartedRunRow,
  scenarioRowsFromIterable,
} from "../scenario.ts"
import { Schema } from "effect"

export const SleepOperation = Operation.define({
  name: "Sleep",
  input: Schema.Struct({
    durationMs: Schema.Number,
    label: Schema.String,
  }),
  output: Schema.Struct({
    durationMs: Schema.Number,
    label: Schema.String,
    slept: Schema.Boolean,
  }),
})

const DEFAULT_SLEEP_RUN_ID = "run-sleep-cli-1"
export const DEFAULT_SLEEP_DURATION_MS = 500
export const DEFAULT_SLEEP_LABEL = "timer-cli-1"

export const makeSleepScenarioRows = (input: {
  readonly runId?: string
  readonly durationMs?: number
  readonly label?: string
} = {}) => {
  const runId = input.runId ?? DEFAULT_SLEEP_RUN_ID
  const durationMs = input.durationMs ?? DEFAULT_SLEEP_DURATION_MS
  const label = input.label ?? DEFAULT_SLEEP_LABEL

  // firegrid-runtime-process.SCENARIOS.1
  // firegrid-runtime-process.SCENARIOS.10
  // firegrid-runtime-process.SCENARIOS.11
  // firegrid-operation-messaging.OPERATIONS.1
  // firegrid-operation-messaging.OPERATIONS.2
  // firegrid-operation-messaging.OPERATIONS.4
  return [
    makeOperationStartedRunRow({
      runId,
      operation: SleepOperation,
      input: {
        durationMs,
        label,
      },
    }),
  ] as const
}

const sleepScenarioRows = defineScenarioRows({
  name: "sleep",
  rows: () => scenarioRowsFromIterable(makeSleepScenarioRows()),
})

export const sleepScenario = defineEmitScenario({
  kind: "emit",
  name: "sleep",
  rows: sleepScenarioRows,
})
