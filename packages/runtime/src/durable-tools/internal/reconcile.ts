/**
 * Crash-recovery reconciler.
 *
 * Implements:
 *  - firegrid-durable-tools.WAIT_FOR.7 — the wait completion row is
 *    authoritative; on startup, completed wait rows whose workflow-engine
 *    deferred has not been observed as done are reconciled by issuing an
 *    idempotent `deferredDone` call. This guards the gap where the router
 *    wrote the completion row but crashed before completing the deferred.
 *
 * `engine.deferredDone` is already idempotent in the Firegrid workflow
 * engine (it upserts only when the deferred row is absent — see
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
    for (const completion of completions) {
      const waitOpt = yield* findWaitByKey(table, completion.waitKey)
      if (Option.isNone(waitOpt)) continue
      const wait = waitOpt.value
      if (completion.outcome === "match" && wait.status !== "completed") {
        continue
      }
      if (completion.outcome === "timeout" && wait.status !== "timed_out") {
        continue
      }
      if (completion.outcome !== "match") {
        // Timeout completions are produced inside the workflow body's race;
        // on replay, the workflow's DurableClock.sleep returns immediately
        // from its persisted state and the race captures the Timeout marker.
        // No router-side bridge is needed for the timeout outcome.
        continue
      }
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
    }
  })
