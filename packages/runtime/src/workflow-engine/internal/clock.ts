import { DurableDeferred, WorkflowEngine } from "@effect/workflow"
import { Effect, Exit } from "effect"
import { WorkflowEngineTable } from "./table.ts"

export const fireDueWorkflowClocks = (
  nowMs: number,
) =>
  Effect.gen(function* () {
    // workflow-engine-durable-state.VALIDATION.3
    const engine = yield* WorkflowEngine.WorkflowEngine
    const table = yield* WorkflowEngineTable
    const pending = yield* table.clockWakeups.query((coll) =>
      coll.toArray.filter(row => row.status === "pending"),
    )
    for (const row of pending) {
      if (row.deadlineMs > nowMs) continue
      yield* table.clockWakeups.upsert({ ...row, status: "fired" })
      yield* engine.deferredDone(DurableDeferred.make(row.deferredName), {
        workflowName: row.workflowName,
        executionId: row.executionId,
        deferredName: row.deferredName,
        exit: Exit.void,
      })
    }
  })
