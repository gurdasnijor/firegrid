/**
 * Crash-recovery reconciler.
 *
 * Implements:
 *  - firegrid-durable-tools.WAIT_FOR.7 — the wait completion row is the
 *    authoritative record of resolution. On startup, *any* match completion
 *    row whose corresponding wait row exists is reconciled by issuing an
 *    idempotent `engine.deferredDone` call (and flipping the wait row to
 *    `completed` if it was still `active`). This guards both crash gaps:
 *      (a) completion row written, wait row not yet flipped to `completed`;
 *      (b) wait row flipped to `completed`, `deferredDone` not yet called.
 *
 * `engine.deferredDone` is already idempotent in the Firegrid workflow
 * engine — it upserts only when the deferred row is absent (see
 * `packages/runtime/src/workflow-engine/internal/engine-runtime.ts:263-277`).
 * The reconciler relies on that semantic and does not attempt to detect
 * already-done deferreds itself.
 */

import { type WorkflowEngine } from "@effect/workflow"
import { Effect, Exit, Option } from "effect"
import { type DurableToolsTable, findWaitByKey } from "./table.ts"
import { matchDeferredFor } from "./wait-for.ts"

export const reconcileCompletions = (
  table: DurableToolsTable["Type"],
  engine: WorkflowEngine.WorkflowEngine["Type"],
) =>
  Effect.gen(function*() {
    const completions = yield* table.completions.query((coll) =>
      coll.toArray)
    yield* Effect.forEach(completions, (completion) =>
      Effect.gen(function*() {
        const waitOpt = yield* findWaitByKey(table, completion.waitKey)
        if (Option.isNone(waitOpt)) return
        const wait = waitOpt.value
        // Timeout completions are produced inside the workflow body's race
        // (DurableClock + race deferred), and on replay the race captures
        // the Timeout marker without our help.
        if (completion.outcome !== "match") return
        // If the wait row is still `active`, the router crashed between
        // completion-row write and wait-row flip; bridge by flipping here.
        if (wait.status === "active") {
          yield* table.waits.upsert({ ...wait, status: "completed" })
        }
        // Issue the deferredDone regardless of whether the wait row was
        // already `completed`. The engine's Option.isNone guard makes
        // repeated calls a no-op for already-resolved deferreds.
        // firegrid-durable-tools.WAIT_FOR.7
        yield* engine.deferredDone(
          matchDeferredFor(wait.deferredName),
          {
            workflowName: wait.workflowName,
            executionId: wait.executionId,
            deferredName: wait.deferredName,
            exit: Exit.succeed(completion.matchedRowPayload),
          },
        )
      }))
  })
