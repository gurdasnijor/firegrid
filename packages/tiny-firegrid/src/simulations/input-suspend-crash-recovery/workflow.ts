import {
  DurableClock,
  Workflow,
  WorkflowEngine,
} from "@effect/workflow"
import {
  DurableStreamsWorkflowEngine,
  WorkflowEngineTable,
  type WorkflowEngineTableService,
} from "@firegrid/runtime/engine/durable-streams-workflow-engine"
import { Duration, Effect, Layer, Option, Schema, Stream } from "effect"
import { DurableTable } from "effect-durable-operators"

// S1 — input-suspend-crash-recovery.
//
// Empirically test the axis-2 durability gap CC3 inferred from the engine
// source (Q3 §3): a workflow body parked on `Workflow.suspend` waiting for a
// workflow-owned table input row is NOT re-armed by engine reconstruction (only
// clock wakeups are), and the write-row / `engine.resume` pair is two
// untransacted steps (crash between → input durable, wake-up lost).
//
// The "crash" / "restart" primitive is the engine's own lifecycle: a generation
// is one `DurableStreamsWorkflowEngine` scope built over a run-scoped Durable
// Streams server. Closing the scope drops the in-memory `running`/`workflows`
// maps and any forked wakeup fibers (= process death); the durable rows persist
// on the server. A fresh engine layer over the SAME stream URL is a faithful
// reconstruction — exactly what `DurableStreamsWorkflowEngine.test.ts`
// VALIDATION.3/.5 exercise across `runWith` calls.

const now = (): string => new Date().toISOString()

const InputRowSchema = Schema.Struct({
  key: Schema.String.pipe(DurableTable.primaryKey),
  value: Schema.String,
}).annotations({
  identifier: "firegrid.s1.inputRow",
  title: "S1 workflow-owned input row",
})

// A processed-marker is the body's own durable side effect: written
// (idempotently) the moment the body actually consumes an input. It is an
// engine-independent witness that the body ran its consume step — distinct from
// the engine's `executions.finalResult` memoization, so an assertion can't be
// satisfied by engine bookkeeping alone.
const ProcessedRowSchema = Schema.Struct({
  key: Schema.String.pipe(DurableTable.primaryKey),
  value: Schema.String,
  processedAt: Schema.String,
}).annotations({
  identifier: "firegrid.s1.processedRow",
  title: "S1 processed-input marker",
})

class S1Table extends DurableTable("s1.input", {
  inputs: InputRowSchema,
  processed: ProcessedRowSchema,
}) {}

// tf-e5rf shape: read the workflow-owned input row; if absent, voluntarily
// suspend (NO deferred mailbox); if present, record the processed-marker and
// complete with the row value.
export const WakeWorkflow = Workflow.make({
  name: "s1-wake-workflow",
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.String,
  idempotencyKey: payload => payload.id,
})

const wakeBody = (payload: { readonly id: string }) =>
  Effect.gen(function*() {
    const instance = yield* WorkflowEngine.WorkflowInstance
    const table = yield* S1Table
    // A store read failure is a defect, not an expected workflow error
    // (WakeWorkflow declares no error schema) — orDie keeps the body error-never.
    const row = yield* table.inputs.get(payload.id).pipe(Effect.orDie)
    if (Option.isNone(row)) {
      yield* Effect.annotateCurrentSpan({
        "firegrid.s1.body.decision": "suspend",
        "firegrid.s1.input.key": payload.id,
      })
      return yield* Workflow.suspend(instance)
    }
    yield* table.processed.insertOrGet({
      key: payload.id,
      value: row.value.value,
      processedAt: now(),
    }).pipe(Effect.orDie)
    yield* Effect.annotateCurrentSpan({
      "firegrid.s1.body.decision": "process",
      "firegrid.s1.input.key": payload.id,
      "firegrid.s1.input.value": row.value.value,
    })
    return row.value.value
  }).pipe(
    Effect.withSpan("firegrid.s1.wake_workflow.body", {
      kind: "consumer",
      attributes: {
        "firegrid.workflow.name": "s1-wake-workflow",
      },
    }),
  )

// Contrast control (Probe C): a body parked on a DurableClock. The engine's
// `recoverPendingClockWakeups` re-arms clock wakeups on reconstruction — the
// ONE recovery mechanism the engine already has — so this completes after
// restart WITHOUT any explicit resume. Side-by-side with the table-wait gap it
// shows the asymmetry and points at the natural fix shape.
export const ClockWorkflow = Workflow.make({
  name: "s1-clock-workflow",
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.String,
  idempotencyKey: payload => payload.id,
})

const clockBody = (_payload: { readonly id: string }) =>
  Effect.gen(function*() {
    yield* DurableClock.sleep({
      name: "s1-clock-wake",
      duration: Duration.millis(400),
      inMemoryThreshold: Duration.zero,
    })
    return "clock-fired"
  }).pipe(
    Effect.withSpan("firegrid.s1.clock_workflow.body", {
      kind: "consumer",
      attributes: {
        "firegrid.workflow.name": "s1-clock-workflow",
      },
    }),
  )

const tableLayerFor = (inputStreamUrl: string) =>
  S1Table.layer({
    streamOptions: { url: inputStreamUrl, contentType: "application/json" },
    txTimeoutMs: 2_000,
  })

const engineLayerFor = (engineStreamUrl: string) =>
  DurableStreamsWorkflowEngine.layer({ streamUrl: engineStreamUrl })

export interface GenerationUrls {
  readonly engineStreamUrl: string
  readonly inputStreamUrl: string
}

// The engine context a generation provides. WorkflowEngine stays in the
// requirement channel of the program (the Workflow.execute/resume APIs pull it
// ambiently); the durable tables are resolved up-front and handed in as values
// so the program's requirement channel stays free of the DurableTable Tags'
// loose typing.
type WakeGenerationCtx = WorkflowEngine.WorkflowEngine | WorkflowEngineTable | S1Table

interface WakeServices {
  readonly engineTable: WorkflowEngineTableService
  readonly inputTable: S1Table["Type"]
}

// Run one engine generation registered with the WakeWorkflow (tf-e5rf shape)
// and the input table. Scope close = crash; the durable stream URLs persist.
export const runWakeGeneration = <A>(
  urls: GenerationUrls,
  program: (services: WakeServices) => Effect.Effect<A, unknown, WorkflowEngine.WorkflowEngine>,
): Effect.Effect<A, unknown> => {
  const inputTableLayer = tableLayerFor(urls.inputStreamUrl)
  const workflowLayer = WakeWorkflow.toLayer(wakeBody).pipe(
    Layer.provide(inputTableLayer),
  )
  const generationLayer = Layer.mergeAll(workflowLayer, inputTableLayer).pipe(
    Layer.provideMerge(engineLayerFor(urls.engineStreamUrl)),
  )
  // Cast absorbs the DurableTable Tag's loose (`any`) requirement typing that
  // the internal table yields introduce; the layer fully provides the context.
  return Effect.scoped(
    Effect.gen(function*() {
      const engineTable = yield* WorkflowEngineTable
      const inputTable = yield* S1Table
      return yield* program({ engineTable, inputTable })
    }).pipe(
      Effect.provide(generationLayer as Layer.Layer<WakeGenerationCtx, unknown, never>),
    ),
  ) as Effect.Effect<A, unknown>
}

// Run one engine generation registered with the ClockWorkflow only.
export const runClockGeneration = <A>(
  engineStreamUrl: string,
  program: (engineTable: WorkflowEngineTableService) => Effect.Effect<A, unknown, WorkflowEngine.WorkflowEngine>,
): Effect.Effect<A, unknown> => {
  const workflowLayer = ClockWorkflow.toLayer(clockBody)
  const generationLayer = workflowLayer.pipe(
    Layer.provideMerge(engineLayerFor(engineStreamUrl)),
  )
  // Cast absorbs the DurableTable Tag's loose (`any`) requirement typing; the
  // layer fully provides the context.
  return Effect.scoped(
    Effect.gen(function*() {
      const engineTable = yield* WorkflowEngineTable
      return yield* program(engineTable)
    }).pipe(
      Effect.provide(generationLayer as Layer.Layer<WorkflowEngine.WorkflowEngine | WorkflowEngineTable, unknown, never>),
    ),
  ) as Effect.Effect<A, unknown>
}

export interface ExecObservation {
  readonly executionExists: boolean
  readonly suspended: boolean | undefined
  readonly hasFinalResult: boolean
  readonly deferredCount: number
  readonly processed: boolean
  readonly processedValue: string | undefined
}

// Passive durable-state observation (no execute/resume — must not itself drive
// the body, or it would mask the gap). Reads the engine execution row, deferred
// rows for the execution, and the workflow-owned processed marker. Takes the
// resolved service values (not the Tags) so the requirement channel stays
// clean.
export const observeWake = (
  engineTable: WorkflowEngineTableService,
  inputTable: S1Table["Type"],
  executionId: string,
  inputKey: string,
): Effect.Effect<ExecObservation, unknown> =>
  Effect.gen(function*() {
    const exec = yield* engineTable.executions.get(executionId).pipe(
      Effect.map(Option.getOrUndefined),
    )
    const deferreds = yield* engineTable.deferreds.query(coll =>
      coll.toArray.filter(row => row.executionId === executionId),
    )
    const processed = yield* inputTable.processed.get(inputKey).pipe(
      Effect.map(Option.getOrUndefined),
    )
    return {
      executionExists: exec !== undefined,
      suspended: exec?.suspended,
      hasFinalResult: exec?.finalResult !== undefined,
      deferredCount: deferreds.length,
      processed: processed !== undefined,
      processedValue: processed?.value,
    }
  })

// Whether a clock wakeup is durably pending for an execution (pre-crash check).
export const pendingClockWakeups = (
  engineTable: WorkflowEngineTableService,
  executionId: string,
): Effect.Effect<number, unknown> =>
  engineTable.clockWakeups.query(coll =>
    coll.toArray.filter(row =>
      row.executionId === executionId && row.status === "pending"),
  ).pipe(Effect.map(rows => rows.length))

export const isSuspended = (
  engineTable: WorkflowEngineTableService,
  executionId: string,
): Effect.Effect<boolean, unknown> =>
  engineTable.executions.get(executionId).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.map(exec => exec?.suspended === true),
  )

// Bounded wait for an execution row to gain a finalResult, driven off the
// table's live row subscription (not a fixed poll). Used by the clock contrast
// probe, where an auto-rearmed wakeup completes the body asynchronously.
export const awaitFinalResult = (
  engineTable: WorkflowEngineTableService,
  executionId: string,
  timeout: Duration.DurationInput,
): Effect.Effect<boolean, unknown> =>
  engineTable.executions.get(executionId).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.flatMap(exec =>
      exec?.finalResult !== undefined
        ? Effect.succeed(true)
        : engineTable.executions.rows().pipe(
          Stream.filter(row =>
            row.executionId === executionId && row.finalResult !== undefined),
          Stream.runHead,
          Effect.map(Option.isSome),
          Effect.timeoutTo({
            duration: timeout,
            onTimeout: () => false,
            onSuccess: found => found,
          }),
        ),
    ),
  )
