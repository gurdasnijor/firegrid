/**
 * Unified Subscriber Kernel — substrate primitives.
 *
 * Implements the kernel-owned write+arm primitive from
 * `docs/cannon/architecture/kernel-owned-write-arm.md`, ported from the
 * `kernel-owned-write-arm` simulation. This is the "missing engine
 * capability" that lets every subscriber be a workflow body parked on
 * `Workflow.suspend`, with restart recovery scoped to the kernel's own
 * pending commands (not a generic engine sweep).
 *
 * Three pieces:
 *
 *   1. `KernelCommandTable` — durable record of write+arm intents.
 *   2. `kernelWriteArm(execId, key, value, workflow)` — atomic command:
 *      record fact, write workflow-owned row, resume execution.
 *   3. `replayPendingWriteArm(workflows)` — startup sweep over the
 *      kernel's own facts (NOT engine.executions). Re-issues write+arm
 *      for each command whose execution has no finalResult.
 *
 * Each piece is idempotent. The kernel is the only thing the
 * subscribers depend on for "wake me when a fact arrives." Subscribers
 * never touch `engine.resume` directly.
 */

import {
  WorkflowEngine,
  type Workflow,
} from "@effect/workflow"
import {
  WorkflowEngineTable,
  type WorkflowEngineTableService,
} from "@firegrid/runtime/engine/durable-streams-workflow-engine"
import { Effect, Option, Schema } from "effect"
import { DurableTable } from "effect-durable-operators"

// ── KernelCommandTable ───────────────────────────────────────────────────────

export const KernelCommandRowSchema = Schema.Struct({
  commandKey: Schema.String.pipe(DurableTable.primaryKey),
  /** Workflow name — used to look up the workflow's resume() at replay. */
  workflowName: Schema.String,
  /** Execution id of the owning workflow body. */
  executionId: Schema.String,
  /** Logical table name the input row belongs to (audit trail). */
  inputTable: Schema.String,
  /**
   * Stable input identifier. Combined with `inputTable` this lets a
   * subscriber that hosts more than one input shape derive a unique key.
   */
  inputKey: Schema.String,
  /** JSON-encoded payload the workflow body will consume. */
  inputValueJson: Schema.String,
  /** "pending" until the execution gains a finalResult; then "satisfied". */
  status: Schema.Literal("pending", "satisfied"),
  recordedAt: Schema.String,
}).annotations({
  identifier: "firegrid.unified.kernelCommand",
  title: "kernel-owned write+arm command fact",
})

export type KernelCommandRow = Schema.Schema.Type<typeof KernelCommandRowSchema>

export class KernelCommandTable extends DurableTable("firegrid.unified.kernel", {
  commands: KernelCommandRowSchema,
}) {}

export type KernelCommandTableService = KernelCommandTable["Type"]

const now = (): string => new Date().toISOString()

const commandKeyFor = (
  workflowName: string,
  executionId: string,
  inputKey: string,
): string => `${workflowName}|${executionId}|${inputKey}`

// ── Kernel write+arm command ─────────────────────────────────────────────────

/**
 * Minimal shape a workflow needs to expose so the kernel can resume it.
 * Both `@effect/workflow`'s `Workflow.make` results and the simulation's
 * test workflows satisfy this.
 */
export interface ResumableWorkflow<Name extends string = string> {
  readonly name: Name
  readonly resume: (
    executionId: string,
  ) => Effect.Effect<void, never, WorkflowEngine.WorkflowEngine>
}

/**
 * Step 1+2: record the kernel fact, then write the workflow-owned row.
 * Both idempotent. Useful for tests that want to model "crash between
 * write and arm" — call this without calling arm, then close the
 * generation. Production code should call `kernelWriteArm` instead.
 */
export const kernelRecordAndWrite = <Row, RowR>(options: {
  readonly kernel: KernelCommandTableService
  readonly workflowName: string
  readonly executionId: string
  readonly inputTable: string
  readonly inputKey: string
  readonly write: (value: Row) => Effect.Effect<void, unknown, RowR>
  readonly value: Row
  readonly serializeValue: (value: Row) => string
}): Effect.Effect<void, unknown, RowR> =>
  Effect.gen(function*() {
    yield* options.kernel.commands.insertOrGet({
      commandKey: commandKeyFor(
        options.workflowName,
        options.executionId,
        options.inputKey,
      ),
      workflowName: options.workflowName,
      executionId: options.executionId,
      inputTable: options.inputTable,
      inputKey: options.inputKey,
      inputValueJson: options.serializeValue(options.value),
      status: "pending",
      recordedAt: now(),
    }).pipe(Effect.orDie)
    yield* options.write(options.value)
  }).pipe(
    Effect.withSpan("firegrid.unified.kernel.record_and_write", {
      kind: "internal",
      attributes: {
        "firegrid.workflow.name": options.workflowName,
        "firegrid.workflow.execution_id": options.executionId,
        "firegrid.unified.input_table": options.inputTable,
        "firegrid.unified.input_key": options.inputKey,
      },
    }),
  )

/**
 * Idempotent durable write of a workflow-owned input row, paired with an
 * idempotent resume of the owning execution. Records the kernel fact
 * FIRST so restart replay can find it.
 *
 * The kernel is responsible for serializing concurrent write+arms for
 * the same `(workflowName, executionId, inputKey)` — see
 * `withKernelKeyMutex` in `per-key-mutex.ts`.
 */
export const kernelWriteArm = <Row, RowR>(options: {
  readonly kernel: KernelCommandTableService
  readonly workflow: ResumableWorkflow
  readonly executionId: string
  readonly inputTable: string
  readonly inputKey: string
  readonly write: (value: Row) => Effect.Effect<void, unknown, RowR>
  readonly value: Row
  readonly serializeValue: (value: Row) => string
}): Effect.Effect<void, unknown, WorkflowEngine.WorkflowEngine | RowR> =>
  Effect.gen(function*() {
    yield* options.kernel.commands.insertOrGet({
      commandKey: commandKeyFor(
        options.workflow.name,
        options.executionId,
        options.inputKey,
      ),
      workflowName: options.workflow.name,
      executionId: options.executionId,
      inputTable: options.inputTable,
      inputKey: options.inputKey,
      inputValueJson: options.serializeValue(options.value),
      status: "pending",
      recordedAt: now(),
    }).pipe(Effect.orDie)
    yield* options.write(options.value)
    yield* options.workflow.resume(options.executionId)
  }).pipe(
    Effect.withSpan("firegrid.unified.kernel.write_arm", {
      kind: "internal",
      attributes: {
        "firegrid.workflow.name": options.workflow.name,
        "firegrid.workflow.execution_id": options.executionId,
        "firegrid.unified.input_table": options.inputTable,
        "firegrid.unified.input_key": options.inputKey,
      },
    }),
  )

// ── Restart recovery ─────────────────────────────────────────────────────────

/**
 * Catalogue of workflows the kernel knows how to recover. Keyed by
 * workflow name. The kernel never touches a workflow it doesn't know
 * about — that's the bounded-ownership soundness property.
 */
export interface KernelWorkflowCatalog {
  readonly get: (name: string) => ResumableWorkflow | undefined
}

/**
 * Optional row-rewrite hook so the kernel can re-issue the workflow-
 * owned row write on restart. The subscriber registers a per-workflow
 * rewriter that decodes `inputValueJson` and writes the row.
 *
 * The rewrite is idempotent at the row layer (`insertOrGet`), so calling
 * it on every replay is safe.
 */
export interface KernelRowRewriter {
  readonly forCommand: (
    cmd: KernelCommandRow,
  ) => Effect.Effect<void, unknown> | undefined
}

/**
 * Startup recovery: walk the kernel's OWN pending facts. For each fact
 * whose execution has no finalResult, re-issue the row write and
 * re-arm. Bounded to owned facts; never touches engine.executions for
 * arbitrary suspended workflows.
 *
 * Run AFTER all participating workflows are registered with the engine
 * — the catalog must be able to resolve their names. The simulation's
 * generation harness sequences this for us.
 */
export const replayPendingWriteArm = (options: {
  readonly kernel: KernelCommandTableService
  readonly engineTable: WorkflowEngineTableService
  readonly catalog: KernelWorkflowCatalog
  readonly rewriter: KernelRowRewriter
}): Effect.Effect<{ readonly replayed: number; readonly skipped: number }, unknown, WorkflowEngine.WorkflowEngine> =>
  Effect.gen(function*() {
    const pending = yield* options.kernel.commands.query((coll) =>
      coll.toArray.filter((row) => row.status === "pending"))
    let replayed = 0
    let skipped = 0
    for (const cmd of pending) {
      const exec = yield* options.engineTable.executions.get(cmd.executionId).pipe(
        Effect.map(Option.getOrUndefined),
      )
      if (exec?.finalResult !== undefined) {
        skipped += 1
        continue
      }
      const workflow = options.catalog.get(cmd.workflowName)
      if (workflow === undefined) {
        skipped += 1
        continue
      }
      const rewrite = options.rewriter.forCommand(cmd)
      if (rewrite !== undefined) yield* rewrite
      yield* workflow.resume(cmd.executionId)
      replayed += 1
    }
    return { replayed, skipped }
  }).pipe(
    Effect.withSpan("firegrid.unified.kernel.replay_pending", {
      kind: "internal",
    }),
  )

// ── Helpers exported for subscribers ────────────────────────────────────────

export {
  WorkflowEngine,
  WorkflowEngineTable,
  type Workflow,
}
