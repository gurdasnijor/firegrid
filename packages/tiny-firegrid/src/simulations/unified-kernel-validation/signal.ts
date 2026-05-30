/**
 * Durable Signal — first-class external-event primitive.
 *
 * Standard durable-execution capability that every other workflow
 * runtime ships natively (Temporal Signals, Restate Durable Promises,
 * AWS Step Functions task tokens, Cadence Signals, Conductor WAIT
 * tasks). The Effect workflow engine doesn't expose it directly, so we
 * provide it here as a thin durable composition over the engine —
 * NOT as a polyfill / workaround.
 *
 * The contract:
 *
 *   `awaitSignal<T>({ name })` — inside a workflow body. Parks the
 *     body via `Workflow.suspend` until a producer delivers a signal
 *     by `(executionId, name)`. Returns the resolved value.
 *
 *   `readSignalsFor(executionId)` — inside a workflow body that
 *     consumes an ordered stream of signals (e.g. session inputs).
 *     Returns all resolved signals for `executionId` in `recordedAt`
 *     order; combine with `Workflow.suspend` to wait for more.
 *
 *   `sendSignal<T>({ workflow, executionId, name, value })` — from a
 *     producer. Atomically: records the signal row, performs the
 *     optional companion row write, calls `engine.resume(executionId)`.
 *     The record-before-resume order is what makes the wakeup
 *     recoverable: if the producer crashes between the record and the
 *     resume, recovery re-issues the resume on the next engine
 *     reconstruction.
 *
 *   `recordSignal<T>(...)` — record without resuming. Used by tests to
 *     model "crash between durable record and engine resume."
 *
 *   `recoverPendingSignals({ engineTable, catalog })` — engine
 *     reconstruction sweep. Walks the signal table, deduped by
 *     executionId; for each execution that still has no finalResult,
 *     re-issues `engine.resume`. Bounded ownership: never touches
 *     executions for workflows the catalog doesn't know about.
 *
 * The signal table holds the resolved values. There is no per-name
 * "pending" state — a signal either exists in the table (resolved) or
 * doesn't (not yet sent). A body awaiting a signal that hasn't been
 * sent parks; the producer's record-and-resume wakes it.
 */

import {
  WorkflowEngine,
  Workflow as WorkflowNamespace,
} from "@effect/workflow"
import {
  WorkflowEngineTable,
  type WorkflowEngineTableService,
} from "@firegrid/runtime/engine/durable-streams-workflow-engine"
import { Effect, Option, Schema } from "effect"
import { DurableTable } from "effect-durable-operators"

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

// ── Resumable-workflow contract ─────────────────────────────────────────────

/**
 * Minimal shape a workflow needs to expose so the signal primitive
 * can resume it. Both `@effect/workflow`'s `Workflow.make` results and
 * the simulation's test workflows satisfy this.
 */
export interface ResumableWorkflow<Name extends string = string> {
  readonly name: Name
  readonly resume: (
    executionId: string,
  ) => Effect.Effect<void, never, WorkflowEngine.WorkflowEngine>
}

// ── Producer side ───────────────────────────────────────────────────────────

/**
 * Record a signal durably without arming the workflow. Used by tests to
 * simulate "crash between durable record and engine resume" — recovery
 * must close the gap on the next generation.
 */
export const recordSignal = <Row, RowR>(options: {
  readonly signals: SignalTableService
  readonly workflowName: string
  readonly executionId: string
  readonly name: string
  readonly write: (value: Row) => Effect.Effect<void, unknown, RowR>
  readonly value: Row
  readonly serializeValue: (value: Row) => string
}): Effect.Effect<void, unknown, RowR> =>
  Effect.gen(function*() {
    yield* options.signals.signals.insertOrGet({
      signalKey: signalKeyFor(options.executionId, options.name),
      workflowName: options.workflowName,
      executionId: options.executionId,
      name: options.name,
      payloadJson: options.serializeValue(options.value),
      recordedAt: now(),
    }).pipe(Effect.orDie)
    yield* options.write(options.value)
  }).pipe(
    Effect.withSpan("firegrid.unified.signal.record", {
      kind: "internal",
      attributes: {
        "firegrid.workflow.name": options.workflowName,
        "firegrid.workflow.execution_id": options.executionId,
        "firegrid.unified.signal.name": options.name,
      },
    }),
  )

/**
 * Atomic send: record the signal durably, perform the optional
 * companion row write, then resume the owning execution. The
 * record-before-resume order is what makes the wakeup recoverable.
 *
 * For the common case where the signal payload IS the data (session
 * inputs, permission decisions), pass `write: () => Effect.void` — the
 * payload travels in the signal row's `payloadJson`. For
 * fact-observer cases (webhook, peer event) the producer writes the
 * external fact row separately BEFORE calling sendSignal; the signal
 * is just the wake notification.
 */
export const sendSignal = <Row, RowR>(options: {
  readonly signals: SignalTableService
  readonly workflow: ResumableWorkflow
  readonly executionId: string
  readonly name: string
  readonly write: (value: Row) => Effect.Effect<void, unknown, RowR>
  readonly value: Row
  readonly serializeValue: (value: Row) => string
}): Effect.Effect<void, unknown, WorkflowEngine.WorkflowEngine | RowR> =>
  Effect.gen(function*() {
    yield* options.signals.signals.insertOrGet({
      signalKey: signalKeyFor(options.executionId, options.name),
      workflowName: options.workflow.name,
      executionId: options.executionId,
      name: options.name,
      payloadJson: options.serializeValue(options.value),
      recordedAt: now(),
    }).pipe(Effect.orDie)
    yield* options.write(options.value)
    yield* options.workflow.resume(options.executionId)
  }).pipe(
    Effect.withSpan("firegrid.unified.signal.send", {
      kind: "internal",
      attributes: {
        "firegrid.workflow.name": options.workflow.name,
        "firegrid.workflow.execution_id": options.executionId,
        "firegrid.unified.signal.name": options.name,
      },
    }),
  )

// ── Body side ───────────────────────────────────────────────────────────────

/**
 * Read all signals delivered to an execution in `recordedAt` order.
 * Use inside a workflow body that consumes a stream of inputs (e.g.
 * the session input log).
 *
 * Iteration order is durable (recordedAt is an ISO timestamp written
 * at insert), so replay sees the same sequence and per-position
 * `Activity.make` memoization keys remain stable.
 */
export const readSignalsFor = (
  signals: SignalTableService,
  executionId: string,
): Effect.Effect<ReadonlyArray<SignalRow>, unknown> =>
  signals.signals.query((coll) =>
    coll.toArray
      .filter((row) => row.executionId === executionId)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)))

/**
 * Park a workflow body until a signal with the given name is sent to
 * the body's execution. Returns the decoded payload.
 *
 * Implementation: read by `(executionId, name)`; on miss, suspend.
 * The sender's `engine.resume` wakes the body; on replay the body
 * sees the row and returns. Re-execution before the signal exists is
 * a no-op (body re-suspends).
 */
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
      yield* WorkflowNamespace.suspend(instance)
      return yield* Effect.never
    }
  }) as Effect.Effect<T, never, SignalTable | WorkflowEngine.WorkflowInstance>

// ── Recovery sweep ──────────────────────────────────────────────────────────

/**
 * Catalogue of workflows the signal primitive knows how to recover.
 * Keyed by workflow name. The primitive never touches a workflow it
 * doesn't know about — that's the bounded-ownership soundness property.
 */
export interface WorkflowCatalog {
  readonly get: (name: string) => ResumableWorkflow | undefined
}

/**
 * Optional per-signal row rewriter. Only needed when a producer
 * delegated a companion row write to the signal primitive and that
 * row write was lost mid-send. The common case — payload travels in
 * `payloadJson` — does not need a rewriter.
 */
export interface SignalRowRewriter {
  readonly forSignal: (
    row: SignalRow,
  ) => Effect.Effect<void, unknown> | undefined
}

/**
 * Engine reconstruction sweep. Walks the signal table deduped by
 * executionId; for each execution that still has no finalResult,
 * re-issues `engine.resume` (and the optional row rewrite). Bounded
 * to workflows in the catalog, so unrelated executions are never
 * touched.
 */
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
    for (const row of rows) {
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
