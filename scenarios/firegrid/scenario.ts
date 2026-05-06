import type { ChangeEvent } from "@durable-streams/state"
import {
  makeEventStreamStateRow,
  type EventStreamDescriptor,
  type OperationDescriptor,
} from "@firegrid/substrate/descriptors"
import {
  blockRun,
  CompletionValue,
  createPendingCompletion,
  OPERATION_ENVELOPE_TAG,
  OperationEnvelopeSchema,
  resolveCompletion,
  RunValue,
  startRun,
} from "@firegrid/substrate/kernel"
import { Effect, Schema, Stream } from "effect"

type ScenarioRow = ChangeEvent<unknown>
type ScenarioRowStream = Stream.Stream<ScenarioRow, never, never>

interface ScenarioRowsDefinition {
  readonly name: string
  readonly rows: () => ScenarioRowStream
}

interface ScenarioRowsInput {
  readonly name: string
  readonly rows: ScenarioRowStream | (() => ScenarioRowStream)
}

type ScenarioOperation = OperationDescriptor<
  string,
  Schema.Schema.AnyNoContext,
  Schema.Schema.All,
  Schema.Schema.All
>

type ScenarioEventStream = EventStreamDescriptor<
  string,
  Schema.Schema.AnyNoContext
>

// firegrid-runtime-process.SCENARIOS.10
export const defineScenarioRows = (
  definition: ScenarioRowsInput,
): ScenarioRowsDefinition => {
  if (typeof definition.rows === "function") {
    return Object.freeze({
      name: definition.name,
      rows: definition.rows,
    })
  }
  const rows = definition.rows
  return Object.freeze({
    name: definition.name,
    rows: () => rows,
  })
}

export const scenarioRowsFromIterable = (
  rows: Iterable<ScenarioRow>,
): ScenarioRowStream => Stream.fromIterable(rows)

const encodeOperationEnvelope = <Op extends ScenarioOperation>(
  operation: Op,
  input: Schema.Schema.Type<Op["input"]>,
) =>
  Schema.encodeSync(OperationEnvelopeSchema)({
    _envelope: OPERATION_ENVELOPE_TAG,
    operation: operation.name,
    payload: Schema.encodeSync(operation.input)(input),
  })

export const makeOperationStartedRunRow = <Op extends ScenarioOperation>(input: {
  readonly runId: string
  readonly operation: Op
  readonly input: Schema.Schema.Type<Op["input"]>
}): ScenarioRow => {
  const runValue = Schema.encodeSync(RunValue)({
    runId: input.runId,
    state: "started",
    data: encodeOperationEnvelope(input.operation, input.input),
  })

  return Effect.runSync(startRun({
    runId: runValue.runId,
    data: runValue.data,
  }))
}

export const makeEventStreamScenarioRow = <S extends ScenarioEventStream>(input: {
  readonly stream: S
  readonly eventId: string
  readonly event: Schema.Schema.Type<S["event"]>
}): ScenarioRow =>
  makeEventStreamStateRow({
    stream: input.stream.name,
    eventId: input.eventId,
    event: Schema.encodeSync(input.stream.event)(input.event),
  })

export const makePendingCompletionScenarioRow = (input: {
  readonly completionId: string
  readonly workId: string
  readonly kind: CompletionValue["kind"]
  readonly data: unknown
}): ScenarioRow =>
  Effect.runSync(createPendingCompletion({
    completionId: input.completionId,
    workId: input.workId,
    kind: input.kind,
    data: input.data,
  }))

export const blockRunScenarioRow = (
  runRow: ScenarioRow,
  input: {
    readonly blockedOnCompletionId: string
  },
): ScenarioRow =>
  Effect.runSync(
    blockRun(Schema.decodeUnknownSync(RunValue)(runRow.value), input),
  )

export const resolveCompletionScenarioRow = (
  completionRow: ScenarioRow,
  input: {
    readonly result: unknown
  },
): ScenarioRow =>
  Effect.runSync(
    resolveCompletion(
      Schema.decodeUnknownSync(CompletionValue)(completionRow.value),
      input,
    ),
  )

export const writeScenarioRowsToNdjson = (
  scenario: ScenarioRowsDefinition,
  write: (chunk: string) => void = (chunk) => {
    process.stdout.write(chunk)
  },
): void => {
  // firegrid-runtime-process.SCENARIOS.10
  Effect.runSync(
    Stream.runForEach(scenario.rows(), (row) =>
      Effect.sync(() => {
        write(`${JSON.stringify(row)}\n`)
      })
    ),
  )
}
