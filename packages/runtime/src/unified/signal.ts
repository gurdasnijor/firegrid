/**
 * Durable Signal — first-class external-event primitive.
 *
 * Standard durable-execution capability that every other workflow
 * runtime ships natively (Temporal Signals, Restate Durable Promises,
 * AWS Step Functions task tokens, Cadence Signals, Conductor WAIT
 * tasks). The Effect workflow engine doesn't expose it directly, so
 * we provide it here as a thin durable composition over the engine.
 *
 * Lifted from `packages/tiny-firegrid/src/simulations/unified-kernel-
 * validation/signal.ts` as part of Phase 2 of
 * `SDD_FIREGRID_PROTOCOL_RESPONSE_UNIFICATION`. The simulation
 * continues to source the primitive via re-export so it remains the
 * runnable harness verifying the unified architecture.
 *
 * The contract:
 *
 *   `awaitSignal<T>({ name })` — inside a workflow body. Parks the
 *     body via `Workflow.suspend` until a producer delivers a signal
 *     by `(executionId, name)`. Returns the resolved value.
 *
 *   `readSignalsFor(executionId)` — inside a workflow body that
 *     consumes an ordered stream of signals (e.g. session inputs).
 *
 *   `sendSignal<T>({ workflow, executionId, name, value })` — from a
 *     producer. Atomically: records the signal row, performs the
 *     optional companion row write, calls `engine.resume(executionId)`.
 *     The record-before-resume order is what makes the wakeup
 *     recoverable.
 *
 *   `recordSignal<T>(...)` — record without resuming. Models "crash
 *     between durable record and engine resume" in tests + sims.
 *
 *   `recoverPendingSignals({ engineTable, catalog })` — engine
 *     reconstruction sweep. Walks the signal table deduped by
 *     executionId; re-issues `engine.resume` for executions whose
 *     bodies are still unresolved.
 */

import {
  WorkflowEngine,
  Workflow as WorkflowNamespace,
} from "@effect/workflow"
import { Effect, Option, Schema } from "effect"
import { DurableTable } from "effect-durable-operators"
import {
  WorkflowEngineTable,
  type WorkflowEngineTableService,
} from "../engine/durable-streams-workflow-engine.ts"

// ── SignalTable ─────────────────────────────────────────────────────────────

export const SignalRowSchema = Schema.Struct({
  /** Primary key: `${executionId}|${name}`. */
  signalKey: Schema.String.pipe(DurableTable.primaryKey),
  /** Workflow name — used to look up `resume` at recovery time. */
  workflowName: Schema.String,
  /** Execution id of the owning workflow body. */
  executionId: Schema.String,
  /** Logical signal name within the execution (e.g. "permission-decision"). */
  name: Schema.String,
  /** JSON-encoded payload the workflow body consumes. */
  payloadJson: Schema.String,
  recordedAt: Schema.String,
}).annotations({
  identifier: "firegrid.unified.signal",
  title: "durable signal — external event + payload",
})

export type SignalRow = Schema.Schema.Type<typeof SignalRowSchema>

export class SignalTable extends DurableTable("firegrid.unified.signals", {
  signals: SignalRowSchema,
}) {}

export type SignalTableService = SignalTable["Type"]

const now = (): string => new Date().toISOString()

const signalKeyFor = (executionId: string, name: string): string =>
  `${executionId}|${name}`

const insertSignalRow = (options: {
  readonly signals: SignalTableService
  readonly workflowName: string
  readonly executionId: string
  readonly name: string
  readonly payloadJson: string
}) =>
  options.signals.signals.insertOrGet({
    signalKey: signalKeyFor(options.executionId, options.name),
    workflowName: options.workflowName,
    executionId: options.executionId,
    name: options.name,
    payloadJson: options.payloadJson,
    recordedAt: now(),
  }).pipe(Effect.orDie)

const signalSpanAttributes = (options: {
  readonly workflowName: string
  readonly executionId: string
  readonly name: string
}) => ({
  "firegrid.workflow.name": options.workflowName,
  "firegrid.workflow.execution_id": options.executionId,
  "firegrid.unified.signal.name": options.name,
})

// ── Resumable-workflow contract ─────────────────────────────────────────────

export interface ResumableWorkflow<Name extends string = string> {
  readonly name: Name
  readonly resume: (
    executionId: string,
  ) => Effect.Effect<void, never, WorkflowEngine.WorkflowEngine>
}

interface SignalWriteOptions<Row, RowR> {
  readonly signals: SignalTableService
  readonly executionId: string
  readonly name: string
  readonly write: (value: Row) => Effect.Effect<void, unknown, RowR>
  readonly value: Row
  readonly serializeValue: (value: Row) => string
}

// ── Producer side ───────────────────────────────────────────────────────────

export const recordSignal = <Row, RowR>(options: SignalWriteOptions<Row, RowR> & {
  readonly workflowName: string
}): Effect.Effect<void, unknown, RowR> =>
  Effect.gen(function*() {
    yield* insertSignalRow({
      signals: options.signals,
      workflowName: options.workflowName,
      executionId: options.executionId,
      name: options.name,
      payloadJson: options.serializeValue(options.value),
    })
    yield* options.write(options.value)
  }).pipe(
    Effect.withSpan("firegrid.unified.signal.record", {
      kind: "internal",
      attributes: signalSpanAttributes(options),
    }),
  )

export const sendSignal = <Row, RowR>(options: SignalWriteOptions<Row, RowR> & {
  readonly workflow: ResumableWorkflow
}): Effect.Effect<void, unknown, WorkflowEngine.WorkflowEngine | RowR> =>
  Effect.gen(function*() {
    yield* insertSignalRow({
      signals: options.signals,
      workflowName: options.workflow.name,
      executionId: options.executionId,
      name: options.name,
      payloadJson: options.serializeValue(options.value),
    })
    yield* options.write(options.value)
    yield* options.workflow.resume(options.executionId)
  }).pipe(
    Effect.withSpan("firegrid.unified.signal.send", {
      kind: "internal",
      attributes: signalSpanAttributes({
        workflowName: options.workflow.name,
        executionId: options.executionId,
        name: options.name,
      }),
    }),
  )

// ── Body side ───────────────────────────────────────────────────────────────

export const readSignalsFor = (
  signals: SignalTableService,
  executionId: string,
): Effect.Effect<ReadonlyArray<SignalRow>, unknown> =>
  signals.signals.query((coll) =>
    coll.toArray
      .filter((row) => row.executionId === executionId)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)))

export const awaitSignal = <T>(options: {
  readonly name: string
  readonly parse?: (payloadJson: string) => T
}): Effect.Effect<T, never, SignalTable | WorkflowEngine.WorkflowInstance> =>
  Effect.gen(function*() {
    const instance = yield* WorkflowEngine.WorkflowInstance
    const table = yield* SignalTable
    const key = signalKeyFor(instance.executionId, options.name)
    while (true) {
      const row = yield* table.signals.get(key).pipe(Effect.orDie)
      if (Option.isSome(row)) {
        const parse = options.parse ?? ((s) => JSON.parse(s) as T)
        return parse(row.value.payloadJson)
      }
      return yield* WorkflowNamespace.suspend(instance)
    }
  }) as Effect.Effect<T, never, SignalTable | WorkflowEngine.WorkflowInstance>

// ── Recovery sweep ──────────────────────────────────────────────────────────

export interface WorkflowCatalog {
  readonly get: (name: string) => ResumableWorkflow | undefined
}

export interface SignalRowRewriter {
  readonly forSignal: (
    row: SignalRow,
  ) => Effect.Effect<void, unknown> | undefined
}

export const recoverPendingSignals = (options: {
  readonly signals: SignalTableService
  readonly engineTable: WorkflowEngineTableService
  readonly catalog: WorkflowCatalog
  readonly rewriter?: SignalRowRewriter
}): Effect.Effect<{ readonly replayed: number; readonly skipped: number }, unknown, WorkflowEngine.WorkflowEngine> =>
  Effect.gen(function*() {
    const rows = yield* options.signals.signals.query((coll) => coll.toArray)
    let replayed = 0
    let skipped = 0
    const seen = new Set<string>()
    let index = 0
    while (index < rows.length) {
      const row = rows[index]!
      index += 1
      const rewrite = options.rewriter?.forSignal(row)
      if (rewrite !== undefined) yield* rewrite
      if (seen.has(row.executionId)) continue
      seen.add(row.executionId)
      const exec = yield* options.engineTable.executions.get(row.executionId).pipe(
        Effect.map(Option.getOrUndefined),
      )
      if (exec?.finalResult !== undefined) {
        skipped += 1
        continue
      }
      const workflow = options.catalog.get(row.workflowName)
      if (workflow === undefined) {
        skipped += 1
        continue
      }
      yield* workflow.resume(row.executionId)
      replayed += 1
    }
    return { replayed, skipped }
  }).pipe(
    Effect.withSpan("firegrid.unified.signal.recover", {
      kind: "internal",
    }),
  )

// ── Re-exports for subscribers ──────────────────────────────────────────────

export {
  WorkflowEngine,
  WorkflowEngineTable,
}
