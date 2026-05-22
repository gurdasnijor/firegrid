import type { FiregridHost } from "@firegrid/host-sdk"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import {
  ChannelRouteVerbNotSupported,
  type ChannelDispatchRequest,
} from "@firegrid/protocol/channels/router"
import { Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import {
  DurableTable,
  type DurableTableLayerOptions,
} from "effect-durable-operators"
import type { TinyFiregridHostEnv } from "../../types.ts"
import {
  TinyInputAppendSchema,
  tinyInputAppendChannelTarget,
  type TinyInputAppend,
} from "./protocol.ts"

const contextId = "phase0c-context"

const ContextRowSchema = Schema.Struct({
  contextId: Schema.String.pipe(DurableTable.primaryKey),
  nextInputSequenceToAssign: Schema.Number,
  nextInputSequence: Schema.Number,
  processedInputKeys: Schema.Array(Schema.String),
  revision: Schema.Number,
  updatedAt: Schema.String,
}).annotations({
  identifier: "firegrid.tinyPhase0C.contextRow",
  title: "Tiny Phase 0C runtime context row",
})
type ContextRow = Schema.Schema.Type<typeof ContextRowSchema>

const WorkflowInputRowSchema = Schema.Struct({
  inputKey: Schema.String.pipe(DurableTable.primaryKey),
  contextId: Schema.String,
  inputId: Schema.String,
  sequence: Schema.Number,
  body: Schema.String,
  acceptedAt: Schema.String,
  processedAt: Schema.optional(Schema.String),
}).annotations({
  identifier: "firegrid.tinyPhase0C.workflowInputRow",
  title: "Tiny Phase 0C workflow-owned input row",
})
export type WorkflowInputRow = Schema.Schema.Type<typeof WorkflowInputRowSchema>

const InputIdRowSchema = Schema.Struct({
  inputId: Schema.String.pipe(DurableTable.primaryKey),
  contextId: Schema.String,
  inputKey: Schema.String,
  sequence: Schema.Number,
  createdAt: Schema.String,
}).annotations({
  identifier: "firegrid.tinyPhase0C.inputIdRow",
  title: "Tiny Phase 0C workflow input idempotency row",
})
type InputIdRow = Schema.Schema.Type<typeof InputIdRowSchema>

class TinyInputAppendWakeupTable extends DurableTable(
  "tinyInputAppendWakeup",
  {
    contexts: ContextRowSchema,
    inputs: WorkflowInputRowSchema,
    inputIds: InputIdRowSchema,
  },
) {}

const tableOptions = (
  env: TinyFiregridHostEnv,
): DurableTableLayerOptions => ({
  streamOptions: {
    url: durableStreamUrl(
      env.durableStreamsBaseUrl,
      `${env.namespace}.tiny-input-append-wakeup.${env.runId}`,
    ),
    contentType: "application/json",
  },
  txTimeoutMs: 2_000,
})

interface Instrumentation {
  readonly atomicAppendAttempts: number
  readonly atomicAppendInserted: number
  readonly atomicAppendFound: number
  readonly pointReads: number
  readonly replayPathInputQueries: number
  readonly maxExistingSequenceAllocations: number
  readonly wakeupSignals: number
  readonly wakeupAwaits: number
  readonly bridgeRows: number
}

export interface TinyInputAppendSnapshot {
  readonly context: ContextRow
  readonly inputs: ReadonlyArray<WorkflowInputRow>
  readonly inputIds: ReadonlyArray<InputIdRow>
  readonly instrumentation: Instrumentation
}

interface TinyInputAppendRuntime {
  readonly dispatch: (
    request: ChannelDispatchRequest,
  ) => Effect.Effect<unknown, unknown>
  readonly waitForProcessedCount: (
    count: number,
  ) => Effect.Effect<ContextRow, unknown>
  readonly snapshot: (
    inputIds: ReadonlyArray<string>,
  ) => Effect.Effect<TinyInputAppendSnapshot, unknown>
}

interface PermitLock {
  readonly withPermits: (
    permits: number,
  ) => <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

const runtimeLatch = (() => {
  let resolveRuntime: (runtime: TinyInputAppendRuntime) => void =
    () => undefined
  const promise = new Promise<TinyInputAppendRuntime>((resolve) => {
    resolveRuntime = resolve
  })
  return {
    promise,
    resolve: resolveRuntime,
  }
})()

export const tinyInputAppendRuntime = runtimeLatch.promise

const now = (): string => new Date().toISOString()

const inputKeyFor = (
  ownedContextId: string,
  sequence: number,
): string => `${ownedContextId}/${sequence}`

const initialContext = (): ContextRow => ({
  contextId,
  nextInputSequenceToAssign: 0,
  nextInputSequence: 0,
  processedInputKeys: [],
  revision: 0,
  updatedAt: now(),
})

const emptyInstrumentation: Instrumentation = {
  atomicAppendAttempts: 0,
  atomicAppendInserted: 0,
  atomicAppendFound: 0,
  pointReads: 0,
  replayPathInputQueries: 0,
  maxExistingSequenceAllocations: 0,
  wakeupSignals: 0,
  wakeupAwaits: 0,
  bridgeRows: 0,
}

const getOrCreateContext = (
  table: TinyInputAppendWakeupTable["Type"],
) =>
  table.contexts.get(contextId).pipe(
    Effect.flatMap(Option.match({
      onNone: () =>
        Effect.gen(function*() {
          const row = initialContext()
          yield* table.contexts.insertOrGet(row)
          return row
        }),
      onSome: row => Effect.succeed(row),
    })),
  )

const incrementMetric = (
  metrics: Ref.Ref<Instrumentation>,
  key: keyof Instrumentation,
  by = 1,
) =>
  Ref.update(metrics, current => ({
    ...current,
    [key]: current[key] + by,
  }))

const recordTableWriteWakeup = (
  metrics: Ref.Ref<Instrumentation>,
  inputKey: string,
) =>
  Effect.gen(function*() {
    yield* incrementMetric(metrics, "wakeupSignals")
    yield* Effect.annotateCurrentSpan({
      "firegrid.tiny_phase0c.input_key": inputKey,
    })
  }).pipe(
    Effect.withSpan("firegrid.tiny_phase0c.input_wakeup.signal", {
      kind: "producer",
      attributes: {
        "firegrid-workflow-driven-runtime.ACID":
          "PHASE_0_TARGET_REFERENCE.3,BOUNDARIES.7-1",
      },
    }),
  )

const appendRuntimeContextWorkflowInput = (
  table: TinyInputAppendWakeupTable["Type"],
  metrics: Ref.Ref<Instrumentation>,
  appendLock: PermitLock,
  input: TinyInputAppend,
) =>
  Effect.gen(function*() {
    const row = yield* appendLock.withPermits(1)(
      Effect.gen(function*() {
        yield* incrementMetric(metrics, "atomicAppendAttempts")
        const existingId = yield* table.inputIds.get(input.inputId)
        if (Option.isSome(existingId)) {
          yield* incrementMetric(metrics, "atomicAppendFound")
          const existing = yield* table.inputs.get(existingId.value.inputKey)
          if (Option.isNone(existing)) {
            return yield* Effect.fail(new Error(
              `inputIds points at missing input row: ${existingId.value.inputKey}`,
            ))
          }
          yield* Effect.annotateCurrentSpan({
            "firegrid.tiny_phase0c.input_id": input.inputId,
            "firegrid.tiny_phase0c.input_key": existing.value.inputKey,
            "firegrid.tiny_phase0c.input.sequence": existing.value.sequence,
            "firegrid.tiny_phase0c.atomic_append.result": "idempotent",
          })
          return existing.value
        }

        const before = yield* getOrCreateContext(table)
        const sequence = before.nextInputSequenceToAssign
        const inputKey = inputKeyFor(input.contextId, sequence)
        const row: WorkflowInputRow = {
          contextId: input.contextId,
          inputId: input.inputId,
          inputKey,
          sequence,
          body: input.body,
          acceptedAt: now(),
        }
        const idRow: InputIdRow = {
          inputId: input.inputId,
          contextId: input.contextId,
          inputKey,
          sequence,
          createdAt: row.acceptedAt,
        }
        yield* table.inputs.insertOrGet(row)
        yield* table.inputIds.insertOrGet(idRow)
        const latest = yield* getOrCreateContext(table)
        yield* table.contexts.upsert({
          ...latest,
          nextInputSequenceToAssign: Math.max(
            latest.nextInputSequenceToAssign,
            sequence + 1,
          ),
          revision: latest.revision + 1,
          updatedAt: now(),
        })
        yield* incrementMetric(metrics, "atomicAppendInserted")
        yield* Effect.annotateCurrentSpan({
          "firegrid.tiny_phase0c.input_id": input.inputId,
          "firegrid.tiny_phase0c.input_key": inputKey,
          "firegrid.tiny_phase0c.input.sequence": sequence,
          "firegrid.tiny_phase0c.atomic_append.result": "inserted",
        })
        return row
      }),
    )
    yield* recordTableWriteWakeup(metrics, row.inputKey)
    return row
  }).pipe(
    Effect.withSpan("firegrid.tiny_phase0c.atomic_input_append", {
      kind: "producer",
      attributes: {
        "firegrid.channel.target": String(tinyInputAppendChannelTarget),
        "firegrid.channel.verb": "send",
        "firegrid-workflow-driven-runtime.ACID":
          "PHASE_0_TARGET_REFERENCE.3,PHASE_0_TARGET_REFERENCE.5",
      },
    }),
  )

const pointReadNextInput = (
  table: TinyInputAppendWakeupTable["Type"],
  metrics: Ref.Ref<Instrumentation>,
  state: ContextRow,
) =>
  Effect.gen(function*() {
    const inputKey = inputKeyFor(state.contextId, state.nextInputSequence)
    yield* incrementMetric(metrics, "pointReads")
    const row = yield* table.inputs.get(inputKey)
    yield* Effect.annotateCurrentSpan({
      "firegrid.tiny_phase0c.input_key": inputKey,
      "firegrid.tiny_phase0c.input.sequence": state.nextInputSequence,
      "firegrid.tiny_phase0c.point_read.found": Option.isSome(row),
    })
    return row
  }).pipe(
    Effect.withSpan("firegrid.tiny_phase0c.workflow.input_point_read", {
      kind: "consumer",
      attributes: {
        "firegrid-workflow-driven-runtime.ACID":
          "PHASE_0_TARGET_REFERENCE.4,PHASE_0_TARGET_REFERENCE.5",
      },
    }),
  )

const processInput = (
  table: TinyInputAppendWakeupTable["Type"],
  tableLock: PermitLock,
  state: ContextRow,
  input: WorkflowInputRow,
) =>
  tableLock.withPermits(1)(Effect.gen(function*() {
    const latest = yield* getOrCreateContext(table)
    const processedInputKeys = latest.processedInputKeys.includes(input.inputKey)
      ? latest.processedInputKeys
      : [...latest.processedInputKeys, input.inputKey]
    const nextState: ContextRow = {
      ...latest,
      nextInputSequence: Math.max(latest.nextInputSequence, input.sequence + 1),
      processedInputKeys,
      revision: latest.revision + 1,
      updatedAt: now(),
    }
    yield* table.inputs.upsert({
      ...input,
      processedAt: now(),
    })
    yield* table.contexts.upsert(nextState)
    yield* Effect.annotateCurrentSpan({
      "firegrid.tiny_phase0c.workflow.input_key": input.inputKey,
      "firegrid.tiny_phase0c.workflow.input_sequence": input.sequence,
      "firegrid.tiny_phase0c.workflow.cursor_before": state.nextInputSequence,
      "firegrid.tiny_phase0c.workflow.cursor_after":
        nextState.nextInputSequence,
    })
    return nextState
  })).pipe(
    Effect.withSpan("firegrid.tiny_phase0c.workflow.transition", {
      kind: "internal",
      attributes: {
        "firegrid.workflow.name": "TinyInputAppendWakeupWorkflow",
        "firegrid-workflow-driven-runtime.ACID":
          "PHASE_0_TARGET_REFERENCE.4",
      },
    }),
  )

const processAvailableInputs = (
  table: TinyInputAppendWakeupTable["Type"],
  metrics: Ref.Ref<Instrumentation>,
  tableLock: PermitLock,
) =>
  Effect.gen(function*() {
    let state = yield* getOrCreateContext(table)
    let row = yield* pointReadNextInput(table, metrics, state)
    while (Option.isSome(row)) {
      state = yield* processInput(table, tableLock, state, row.value)
      row = yield* pointReadNextInput(table, metrics, state)
    }
    return state
  })

const runWorkflow = (
  table: TinyInputAppendWakeupTable["Type"],
  metrics: Ref.Ref<Instrumentation>,
  tableLock: PermitLock,
) =>
  Effect.gen(function*() {
    yield* processAvailableInputs(table, metrics, tableLock)
    yield* table.inputs.rows().pipe(
      Stream.runForEach(row =>
        Effect.gen(function*() {
          yield* incrementMetric(metrics, "wakeupAwaits")
          yield* Effect.annotateCurrentSpan({
            "firegrid.tiny_phase0c.input_key": row.inputKey,
            "firegrid.tiny_phase0c.input.sequence": row.sequence,
          }).pipe(
            Effect.withSpan("firegrid.tiny_phase0c.input_wakeup.await", {
              kind: "consumer",
              attributes: {
                "firegrid-workflow-driven-runtime.ACID":
                  "BOUNDARIES.7-1",
              },
            }),
          )
          yield* processAvailableInputs(table, metrics, tableLock)
        }),
      ),
    )
  })

const unsupportedVerb = (
  request: ChannelDispatchRequest,
  supportedVerbs: ReadonlyArray<"send" | "call" | "wait_for">,
) =>
  new ChannelRouteVerbNotSupported({
    target: String(request.target),
    verb: request.verb,
    direction: "bidirectional",
    supportedVerbs,
  })

const dispatchFor = (
  table: TinyInputAppendWakeupTable["Type"],
  metrics: Ref.Ref<Instrumentation>,
  appendLock: PermitLock,
): TinyInputAppendRuntime["dispatch"] =>
  request =>
    Effect.gen(function*() {
      if (String(request.target) !== String(tinyInputAppendChannelTarget)) {
        return yield* Effect.fail({
          _tag: "UnknownChannelTarget",
          target: String(request.target),
        })
      }
      switch (request.verb) {
        case "send": {
          const payload = yield* Schema.decodeUnknown(TinyInputAppendSchema, {
            onExcessProperty: "error",
          })(request.payload)
          return yield* appendRuntimeContextWorkflowInput(
            table,
            metrics,
            appendLock,
            payload,
          )
        }
        case "call":
        case "wait_for":
          return yield* Effect.fail(unsupportedVerb(request, ["send"]))
      }
    }).pipe(
      Effect.withSpan("firegrid.channel.dispatch", {
        kind: "internal",
        attributes: {
          "firegrid.channel.target": String(request.target),
          "firegrid.channel.verb": request.verb,
          "firegrid.channel.direction": "bidirectional",
        },
      }),
    )

const waitForProcessedCount = (
  table: TinyInputAppendWakeupTable["Type"],
  count: number,
) =>
  Effect.gen(function*() {
    const current = yield* getOrCreateContext(table)
    if (current.nextInputSequence >= count) return current
    const row = yield* table.contexts.rows().pipe(
      Stream.filter(row =>
        row.contextId === contextId &&
        row.nextInputSequence >= count),
      Stream.runHead,
    )
    return yield* Option.match(row, {
      onNone: () =>
        Effect.fail(new Error("context stream ended before cursor advanced")),
      onSome: state => Effect.succeed(state),
    })
  })

const snapshotFor = (
  table: TinyInputAppendWakeupTable["Type"],
  metrics: Ref.Ref<Instrumentation>,
  ids: ReadonlyArray<string>,
): Effect.Effect<TinyInputAppendSnapshot, unknown> =>
  Effect.gen(function*() {
    const state = yield* getOrCreateContext(table)
    const inputs = yield* Effect.forEach(
      Array.from({ length: state.nextInputSequenceToAssign }, (_, sequence) =>
        sequence),
      sequence =>
        table.inputs.get(inputKeyFor(state.contextId, sequence)).pipe(
          Effect.map(Option.getOrUndefined),
        ),
    )
    const inputIds = yield* Effect.forEach(
      ids,
      id =>
        table.inputIds.get(id).pipe(
          Effect.map(Option.getOrUndefined),
        ),
    )
    const instrumentation = yield* Ref.get(metrics)
    return {
      context: state,
      inputs: inputs.filter(row => row !== undefined),
      inputIds: inputIds.filter(row => row !== undefined),
      instrumentation,
    }
  })

const runtimeFor = (
  table: TinyInputAppendWakeupTable["Type"],
  metrics: Ref.Ref<Instrumentation>,
  appendLock: PermitLock,
): TinyInputAppendRuntime => ({
  dispatch: dispatchFor(table, metrics, appendLock),
  waitForProcessedCount: count =>
    waitForProcessedCount(table, count),
  snapshot: inputIds => snapshotFor(table, metrics, inputIds),
})

export const tinyInputAppendWakeupHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown, never> => {
  const tableLayer = TinyInputAppendWakeupTable.layer(tableOptions(env))
  const workflowLayer = Layer.scopedDiscard(
    Effect.gen(function*() {
      const table = yield* TinyInputAppendWakeupTable
      const metrics = yield* Ref.make(emptyInstrumentation)
      const appendLock = yield* Effect.makeSemaphore(1)
      const runtime = runtimeFor(table, metrics, appendLock)
      runtimeLatch.resolve(runtime)
      yield* runWorkflow(table, metrics, appendLock).pipe(
        Effect.forkScoped,
      )
    }),
  )

  return workflowLayer.pipe(
    Layer.provide(tableLayer),
  ) as Layer.Layer<FiregridHost, unknown, never>
}
