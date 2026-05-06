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

const echoScenarioRows = defineScenarioRows({
  name: "echo",
  rows: () => scenarioRowsFromIterable(makeEchoScenarioRows()),
})

export const echoScenario = defineEmitScenario({
  kind: "emit",
  name: "echo",
  rows: echoScenarioRows,
})
