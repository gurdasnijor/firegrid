import { DurableDeferred, WorkflowEngine } from "@effect/workflow"
import { Effect, Exit } from "effect"
import { WorkflowStateStore } from "./state.ts"

export const fireDueWorkflowClocks = (
  nowMs: number,
) =>
  Effect.gen(function* () {
    // workflow-engine-durable-state.VALIDATION.3
    const engine = yield* WorkflowEngine.WorkflowEngine
    const store = yield* WorkflowStateStore
    for (const row of store.pendingClockWakeups()) {
      if (row.deadlineMs > nowMs) continue
      yield* store.putClockWakeup({ ...row, status: "fired" })
      yield* engine.deferredDone(DurableDeferred.make(row.deferredName), {
        workflowName: row.workflowName,
        executionId: row.executionId,
        deferredName: row.deferredName,
        exit: Exit.void,
      })
    }
  })
