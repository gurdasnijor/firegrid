import { CurrentRuntimeContext } from "@firegrid/protocol/launch"
import {
  RuntimeIngressTable,
  makeRuntimeIngressInputRow,
  nextRuntimeIngressSequence,
  type RuntimeIngressInputRow,
  type RuntimeIngressRequest,
} from "@firegrid/protocol/runtime-ingress"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import {
  type RuntimeAuthority,
  type RuntimeAuthorityCommand,
  type RuntimeAuthorityRead,
} from "../events/index.ts"
import { sourceCollectionHandle } from "../waits/internal/source-collections.ts"
import { RuntimeAuthoritySourceNames } from "./source-names.ts"

export class RuntimeIngressAppendContextMismatch extends Schema.TaggedError<RuntimeIngressAppendContextMismatch>()(
  "RuntimeIngressAppendContextMismatch",
  {
    expectedContextId: Schema.String,
    actualContextId: Schema.String,
    inputId: Schema.String,
  },
) {}

interface RuntimeIngressWrites {
  readonly append: RuntimeAuthorityCommand<RuntimeIngressRequest, RuntimeIngressInputRow, unknown>
  readonly findInput: RuntimeAuthorityCommand<string, Option.Option<RuntimeIngressInputRow>, unknown>
}

interface RuntimeIngressReads {
  readonly inputs: RuntimeAuthorityRead
}

export type RuntimeIngressAuthorityService = RuntimeAuthority<
  RuntimeIngressWrites,
  RuntimeIngressReads
>

export class RuntimeIngressAuthority extends Context.Tag(
  "@firegrid/runtime/RuntimeIngressAuthority",
)<RuntimeIngressAuthority, RuntimeIngressAuthorityService>() {}

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

const findInput = (
  inputId: string,
) => Effect.flatMap(RuntimeIngressTable, table => findInputTo(table, inputId))

const append = (
  request: RuntimeIngressRequest,
) =>
  Effect.gen(function* () {
    const context = yield* CurrentRuntimeContext
    const table = yield* RuntimeIngressTable
    return yield* appendTo(table, request, {
      currentContextId: context.contextId,
    })
  })

const sources = (
  table: RuntimeIngressTable["Type"],
) => ({
  inputs: sourceCollectionHandle(
    RuntimeAuthoritySourceNames.runtimeIngressInputs,
    table.inputs,
  ),
}) as const

const authority = (
  table: RuntimeIngressTable["Type"],
  options: {
    readonly currentContextId: string
  },
): RuntimeIngressAuthorityService => ({
  write: {
    append: request => appendTo(table, request, options),
    findInput: inputId => findInputTo(table, inputId),
  },
  read: sources(table),
})

const layer = (options: {
  readonly currentContextId: string
}) =>
  Layer.effect(
    RuntimeIngressAuthority,
    Effect.map(RuntimeIngressTable, table => authority(table, options)),
  )

export const RuntimeIngressAppender = {
  authority,
  layer,
  append,
  appendTo,
  findInput,
  findInputTo,
  sources,
} as const
