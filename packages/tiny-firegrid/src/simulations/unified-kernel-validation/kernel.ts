/**
 * Unified Subscriber Kernel — substrate primitives.
 *
 * Implements the kernel-owned write+arm primitive from
 * `docs/cannon/architecture/kernel-owned-write-arm.md`. This is the
 * missing engine capability that lets every subscriber be a workflow
 * body parked on `Workflow.suspend`, with restart recovery scoped to
 * the kernel's own pending commands.
 *
 * The kernel command IS the durable input log for any workflow body
 * that consumes externally-delivered inputs (session prompts, permission
 * decisions, observer wake notifications). `inputValueJson` carries the
 * input payload; the body iterates its own commands by executionId.
 *
 * Three pieces:
 *
 *   1. `KernelCommandTable` — durable record of write+arm intents +
 *      input payloads.
 *   2. `kernelWriteArm(...)` — atomic command: record the fact (with
 *      payload), perform an optional row write, resume execution.
 *   3. `replayPendingWriteArm(workflows)` — startup sweep over the
 *      kernel's own facts. Re-arms each execution that still has no
 *      finalResult exactly once, even if it has multiple pending
 *      commands. Bounded ownership: never touches executions for
 *      workflows the catalog doesn't know about.
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
  /** Logical input family the command belongs to (audit trail). */
  inputTable: Schema.String,
  /** Stable input identifier within the family. */
  inputKey: Schema.String,
  /** JSON-encoded payload the workflow body will consume. */
  inputValueJson: Schema.String,
  recordedAt: Schema.String,
}).annotations({
  identifier: "firegrid.unified.kernelCommand",
  title: "kernel-owned write+arm command + input payload",
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
 * Step 1+2: record the kernel command (with payload), then perform the
 * optional row write. Useful for tests that want to model "crash between
 * write and arm" — call this without calling arm, then close the
 * generation. Production code calls `kernelWriteArm` instead.
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
 * Idempotent durable record-and-arm. Records the kernel command (with
 * payload) FIRST so restart replay can find it, performs the optional
 * row write, then resumes the owning execution.
 *
 * For session-input / decision-delivery cases the `write` arg is
 * `Effect.void` — the input value lives in the command's
 * `inputValueJson` and the body reads it directly. For fact-observer
 * cases (webhook, peer event) the producer writes the external fact
 * row separately BEFORE calling kernelWriteArm; the kernel command is
 * just the wake notification.
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

// ── Reading kernel commands as durable input log ────────────────────────────

/**
 * Read all kernel commands targeting an execution in `recordedAt`
 * order. Subscriber bodies use this to iterate their own input log.
 *
 * The iteration order is durable (recordedAt is a stable ISO timestamp
 * written at insert) so replay sees the same sequence the original run
 * saw, and `Activity.make` memoization keys remain stable.
 */
export const readCommandsFor = (
  kernel: KernelCommandTableService,
  executionId: string,
): Effect.Effect<ReadonlyArray<KernelCommandRow>, unknown> =>
  kernel.commands.query((coll) =>
    coll.toArray
      .filter((row) => row.executionId === executionId)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)))

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
 * Optional row-rewrite hook so the kernel can re-issue a workflow-owned
 * row write on restart. Most kernel uses don't need this — the input
 * lives in the command's `inputValueJson`, the body reads the command
 * directly. The hook only matters when a producer chose to write a
 * separate row through `kernelWriteArm` and that row write was lost
 * mid-command.
 */
export interface KernelRowRewriter {
  readonly forCommand: (
    cmd: KernelCommandRow,
  ) => Effect.Effect<void, unknown> | undefined
}

/**
 * Startup recovery: walk the kernel's OWN pending facts deduped by
 * executionId. For each execution that still has no finalResult, run
 * the row rewriter for each of its commands then re-arm ONCE.
 *
 * Bounded ownership: never touches executions for workflows the
 * catalog doesn't know about, and never touches executions that have
 * no kernel command (those parked on `DurableDeferred` or
 * `DurableClock` are the engine's own recovery problem).
 */
export const replayPendingWriteArm = (options: {
  readonly kernel: KernelCommandTableService
  readonly engineTable: WorkflowEngineTableService
  readonly catalog: KernelWorkflowCatalog
  readonly rewriter?: KernelRowRewriter
}): Effect.Effect<{ readonly replayed: number; readonly skipped: number }, unknown, WorkflowEngine.WorkflowEngine> =>
  Effect.gen(function*() {
    const commands = yield* options.kernel.commands.query((coll) => coll.toArray)
    let replayed = 0
    let skipped = 0
    const seen = new Set<string>()
    for (const cmd of commands) {
      const rewrite = options.rewriter?.forCommand(cmd)
      if (rewrite !== undefined) yield* rewrite
      if (seen.has(cmd.executionId)) continue
      seen.add(cmd.executionId)
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
