#!/usr/bin/env tsx
import {
  Operation,
} from "@firegrid/substrate/descriptors"
import {
  defineScenarioRows,
  makeOperationStartedRunRow,
  scenarioRowsFromIterable,
  writeScenarioRowsToNdjson,
} from "./scenario.ts"
import { Schema } from "effect"
import { fileURLToPath } from "node:url"

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

export const DEFAULT_SLEEP_RUN_ID = "run-sleep-cli-1"
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

export const sleepScenario = defineScenarioRows({
  name: "sleep",
  rows: () => scenarioRowsFromIterable(makeSleepScenarioRows()),
})

export const writeSleepScenarioRows = (
  write?: (chunk: string) => void,
) => {
  writeScenarioRowsToNdjson(sleepScenario, write)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeSleepScenarioRows()
}
