import {
  RuntimeIngressTable,
  makeRuntimeIngressInputRow,
  nextRuntimeIngressSequence,
  type RuntimeIngressInputRow,
  type RuntimeIngressRequest,
} from "@firegrid/protocol/runtime-ingress"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import type { Stream } from "effect"

export class RuntimeIngressAppendContextMismatch extends Schema.TaggedError<RuntimeIngressAppendContextMismatch>()(
  "RuntimeIngressAppendContextMismatch",
  {
    expectedContextId: Schema.String,
    actualContextId: Schema.String,
    inputId: Schema.String,
  },
) {}

interface RuntimeIngressAppendAndGetService {
  readonly append: (
    request: RuntimeIngressRequest,
  ) => Effect.Effect<RuntimeIngressInputRow, unknown>
  readonly findInput: (
    inputId: string,
  ) => Effect.Effect<Option.Option<RuntimeIngressInputRow>, unknown>
}

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map(millis => new Date(millis).toISOString()),
)

const appendTo = (
  table: RuntimeIngressTable["Type"],
  request: RuntimeIngressRequest,
  options: {
    readonly currentContextId: string
  },
) =>
  Effect.gen(function* () {
    const row = makeRuntimeIngressInputRow(request)
    if (row.contextId !== options.currentContextId) {
      return yield* Effect.fail(new RuntimeIngressAppendContextMismatch({
        expectedContextId: options.currentContextId,
        actualContextId: row.contextId,
        inputId: row.inputId,
      }))
    }
    const existing = yield* table.inputs.get(row.inputId)
    if (Option.isSome(existing)) {
      return existing.value
    }

    const nextSequence = yield* nextRuntimeIngressSequence(table, row.contextId)
    const sequenced: RuntimeIngressInputRow = {
      ...row,
      status: "sequenced",
      sequence: nextSequence,
      sequencedAt: yield* nowIso,
    }
    yield* table.inputs.insert(sequenced)
    return sequenced
  })

const findInputTo = (
  table: RuntimeIngressTable["Type"],
  inputId: string,
) => table.inputs.get(inputId)

const ingressInputStream = (
  table: RuntimeIngressTable["Type"],
): Stream.Stream<RuntimeIngressInputRow, unknown> => table.inputs.rows()

const appendAndGetFromTable = (
  table: RuntimeIngressTable["Type"],
  options: {
    readonly currentContextId: string
  },
): RuntimeIngressAppendAndGetService => ({
  append: request => appendTo(table, request, options),
  findInput: inputId => findInputTo(table, inputId),
})

export class RuntimeIngressAppendAndGet extends Context.Tag(
  "@firegrid/runtime/RuntimeIngressAppendAndGet",
)<RuntimeIngressAppendAndGet, RuntimeIngressAppendAndGetService>() {}

export class RuntimeIngressInputStream extends Context.Tag(
  "@firegrid/runtime/RuntimeIngressInputStream",
)<RuntimeIngressInputStream, Stream.Stream<RuntimeIngressInputRow, unknown>>() {}

export const RuntimeIngressInputStreamLayer = Layer.effect(
  RuntimeIngressInputStream,
  Effect.map(RuntimeIngressTable, ingressInputStream),
)

export const RuntimeIngressAppenderLayer = (options: {
  readonly currentContextId: string
}) =>
  Layer.mergeAll(
    Layer.effect(
      RuntimeIngressAppendAndGet,
      Effect.map(RuntimeIngressTable, table => appendAndGetFromTable(table, options)),
    ),
    Layer.effect(
      RuntimeIngressInputStream,
      Effect.map(RuntimeIngressTable, ingressInputStream),
    ),
)
