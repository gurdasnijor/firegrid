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

import type { WorkflowEngine } from "@effect/workflow"
import { Effect, Exit, Option } from "effect"
import { matchDeferredFor } from "./wait-for.ts"
import type {
  DurableWaitAppendAndGet,
  DurableWaitCompletionAppendAndGet,
} from "./durable-wait-store.ts"

export const reconcileCompletions = (
  waitStore:
    & DurableWaitAppendAndGet["Type"]
    & DurableWaitCompletionAppendAndGet["Type"],
  engine: WorkflowEngine.WorkflowEngine["Type"],
) =>
  Effect.gen(function*() {
    const completions = yield* waitStore.completions
    yield* Effect.forEach(completions, (completion) =>
      Effect.gen(function*() {
        const waitOpt = yield* waitStore.findWait(completion.waitKey)
        if (Option.isNone(waitOpt)) return
        const wait = waitOpt.value
        // Timeout completions are produced inside the workflow body's race
        // (DurableClock + race deferred), and on replay the race captures
        // the Timeout marker without our help.
        if (completion.outcome !== "match") return
        // If the wait row is still `active`, the router crashed between
        // completion-row write and wait-row flip; bridge by flipping here.
        if (wait.status === "active") {
          yield* waitStore.upsertWait({ ...wait, status: "completed" })
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
