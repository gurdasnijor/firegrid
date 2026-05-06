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

export const EchoOperation = Operation.define({
  name: "Echo",
  input: Schema.Struct({
    message: Schema.String,
  }),
  output: Schema.Struct({
    message: Schema.String,
    length: Schema.Number,
  }),
})

const DEFAULT_RUN_ID = "run-echo-cli-1"
const DEFAULT_MESSAGE = "hello firegrid"

export const makeEchoScenarioRows = (input: {
  readonly runId?: string
  readonly message?: string
} = {}) => {
  const runId = input.runId ?? DEFAULT_RUN_ID
  const message = input.message ?? DEFAULT_MESSAGE

  // firegrid-runtime-process.SCENARIOS.1
  // firegrid-operation-messaging.OPERATIONS.1
  // firegrid-operation-messaging.OPERATIONS.2
  // firegrid-operation-messaging.OPERATIONS.4
  return [
    makeOperationStartedRunRow({
      runId,
      operation: EchoOperation,
      input: { message },
    }),
  ] as const
}

export const echoScenario = defineScenarioRows({
  name: "echo",
  rows: () => scenarioRowsFromIterable(makeEchoScenarioRows()),
})

export const writeEchoScenarioRows = (
  write?: (chunk: string) => void,
) => {
  writeScenarioRowsToNdjson(echoScenario, write)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeEchoScenarioRows()
}
