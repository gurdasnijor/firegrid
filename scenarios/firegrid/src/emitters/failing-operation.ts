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

export const FailingOperation = Operation.define({
  name: "FailingOperation",
  input: Schema.Struct({
    requestId: Schema.String,
    reason: Schema.String,
  }),
  output: Schema.Struct({
    requestId: Schema.String,
    ok: Schema.Literal(true),
  }),
  error: Schema.Struct({
    _tag: Schema.Literal("ScenarioFailure"),
    requestId: Schema.String,
    reason: Schema.String,
  }),
})

const DEFAULT_FAILING_RUN_ID = "run-failing-operation-cli-1"
const DEFAULT_FAILING_REQUEST_ID = "request-failing-operation-cli-1"
const DEFAULT_FAILING_REASON = "scenario handler failed intentionally"

export const makeFailingOperationScenarioRows = (input: {
  readonly runId?: string
  readonly requestId?: string
  readonly reason?: string
} = {}) => {
  const runId = input.runId ?? DEFAULT_FAILING_RUN_ID
  const requestId = input.requestId ?? DEFAULT_FAILING_REQUEST_ID
  const reason = input.reason ?? DEFAULT_FAILING_REASON

  // firegrid-runtime-process.SCENARIOS.1
  // firegrid-runtime-process.SCENARIOS.10
  // firegrid-runtime-process.SCENARIOS.12
  // firegrid-operation-messaging.OPERATIONS.1
  // firegrid-operation-messaging.OPERATIONS.2
  // firegrid-operation-messaging.OPERATIONS.4
  return [
    makeOperationStartedRunRow({
      runId,
      operation: FailingOperation,
      input: { requestId, reason },
    }),
  ] as const
}

const failingOperationScenarioRows = defineScenarioRows({
  name: "failing-operation",
  rows: () => scenarioRowsFromIterable(makeFailingOperationScenarioRows()),
})

export const failingOperationScenario = defineEmitScenario({
  kind: "emit",
  name: "failing-operation",
  rows: failingOperationScenarioRows,
})
