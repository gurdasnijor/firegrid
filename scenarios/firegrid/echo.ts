#!/usr/bin/env tsx
import {
  Operation,
} from "@firegrid/substrate/descriptors"
import {
  OPERATION_ENVELOPE_TAG,
  OperationEnvelopeSchema,
  RunValue,
  startRun,
} from "@firegrid/substrate/kernel"
import { Effect, Schema } from "effect"
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
  const encodedInput = Schema.encodeSync(EchoOperation.input)({ message })
  const operationEnvelope = Schema.encodeSync(OperationEnvelopeSchema)({
    _envelope: OPERATION_ENVELOPE_TAG,
    operation: EchoOperation.name,
    payload: encodedInput,
  })
  const runValue = Schema.encodeSync(RunValue)({
    runId,
    state: "started",
    data: operationEnvelope,
  })

  return [
    Effect.runSync(startRun({
      runId: runValue.runId,
      data: runValue.data,
    })),
  ] as const
}

export const writeEchoScenarioRows = (
  write: (chunk: string) => void = (chunk) => {
    process.stdout.write(chunk)
  },
) => {
  for (const row of makeEchoScenarioRows()) {
    write(`${JSON.stringify(row)}\n`)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeEchoScenarioRows()
}
