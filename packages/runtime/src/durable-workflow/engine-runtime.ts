import { Workflow, WorkflowEngine } from "@effect/workflow"
import { Duration, Effect, Fiber, Scope } from "effect"
import {
  decodeWorkflowResult,
  encodeWorkflowResult,
  reviveEncodedResult,
  reviveExit,
} from "./codec.js"
import { orDieStore, type WorkflowStateStore } from "./state.js"

export const makeWorkflowEngine = (
  store: WorkflowStateStore,
): Effect.Effect<WorkflowEngine.WorkflowEngine["Type"]> =>
  Effect.gen(function* () {
    const workflows = new Map<string, {
      workflow: Workflow.Any
      execute: (
        payload: object,
        executionId: string,
      ) => Effect.Effect<unknown, unknown, WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance>
      scope: Scope.Scope
    }>()
    const running = new Map<string, Fiber.RuntimeFiber<Workflow.Result<unknown, unknown>, never>>()

    const resume = Effect.fnUntraced(function*(executionId: string) {
      const row = store.getExecution(executionId)
      if (!row || row.finalResult !== undefined) return
      const entry = workflows.get(row.workflowName)
      if (!entry) return
      const current = running.get(executionId)?.unsafePoll()
      if (!current) {
        if (running.has(executionId)) return
      } else if (current._tag === "Success" && current.value._tag !== "Suspended") {
        return
      }

      const instance = WorkflowEngine.WorkflowInstance.initial(entry.workflow, executionId)
      instance.interrupted = row.interrupted

      const fiber = yield* entry.execute(row.payload as object, executionId).pipe(
        Workflow.intoResult,
        Effect.provideService(WorkflowEngine.WorkflowInstance, instance),
        Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
        Effect.tap(result =>
          Effect.gen(function* () {
            const latest = store.getExecution(executionId) ?? row
            const finalResult = result._tag === "Complete"
              ? yield* encodeWorkflowResult(entry.workflow, result)
              : undefined
            yield* orDieStore(store.putExecution({
              ...latest,
              interrupted: instance.interrupted,
              suspended: result._tag === "Suspended",
              ...(finalResult !== undefined ? { finalResult } : {}),
            }))
          }),
        ),
        Effect.forkIn(entry.scope),
      )
      running.set(executionId, fiber)
    })

    const engine = WorkflowEngine.makeUnsafe({
      register: Effect.fnUntraced(function*(workflow, execute) {
        workflows.set(workflow.name, {
          workflow,
          execute,
          scope: yield* Effect.scope,
        })
      }),
      execute: Effect.fnUntraced(function*(workflow, options) {
        const existing = store.getExecution(options.executionId)
        if (existing?.finalResult !== undefined) {
          return (yield* decodeWorkflowResult(workflow, existing.finalResult)) as never
        }
        if (!existing) {
          yield* orDieStore(store.putExecution({
            executionId: options.executionId,
            workflowName: workflow.name,
            payload: options.payload,
            parentExecutionId: options.parent?.executionId,
            interrupted: false,
            suspended: false,
          }))
        }
        yield* resume(options.executionId)
        const fiber = running.get(options.executionId)
        if (options.discard) {
          if (fiber) yield* Fiber.join(fiber)
          return undefined as never
        }
        if (fiber) return (yield* Fiber.join(fiber)) as never
        const afterResume = store.getExecution(options.executionId)
        if (afterResume?.finalResult !== undefined) {
          return (yield* decodeWorkflowResult(workflow, afterResume.finalResult)) as never
        }
        return new Workflow.Suspended({}) as never
      }),
      poll: (_workflow, executionId) =>
        Effect.gen(function* () {
          const row = store.getExecution(executionId)
          return row?.finalResult === undefined
            ? undefined
            : yield* decodeWorkflowResult(_workflow, row.finalResult)
        }),
      interrupt: (_workflow, executionId) =>
        Effect.gen(function* () {
          const row = store.getExecution(executionId)
          if (!row) return
          yield* orDieStore(store.putExecution({ ...row, interrupted: true }))
          yield* resume(executionId)
        }),
      resume: (_workflow, executionId) => resume(executionId),
      activityExecute: Effect.fnUntraced(function*(activity, attempt) {
        const instance = yield* WorkflowEngine.WorkflowInstance
        const activityKey = `${instance.executionId}/${activity.name}/${attempt}`
        const row = store.getActivity(activityKey)
        if (row?.result !== undefined) {
          const result = reviveEncodedResult(row.result)
          if (result._tag !== "Suspended") return result
        }

        const claim = yield* orDieStore(store.claimActivity({
          claimKey: activityKey,
          executionId: instance.executionId,
          activityName: activity.name,
          attempt,
          workerId: store.workerId,
          claimedAtMs: Date.now(),
        }))
        const completedAfterClaim = store.getActivity(activityKey)
        if (completedAfterClaim?.result !== undefined) {
          const result = reviveEncodedResult(completedAfterClaim.result)
          if (result._tag !== "Suspended") return result
        }
        if (claim.workerId !== store.workerId) {
          return new Workflow.Suspended({})
        }

        const activityInstance = WorkflowEngine.WorkflowInstance.initial(
          instance.workflow,
          instance.executionId,
        )
        activityInstance.interrupted = instance.interrupted
        const result = yield* activity.executeEncoded.pipe(
          Workflow.intoResult,
          Effect.provideService(WorkflowEngine.WorkflowInstance, activityInstance),
        )
        yield* orDieStore(store.putActivity({
          activityKey,
          executionId: instance.executionId,
          activityName: activity.name,
          attempt,
          result,
        }))
        return result
      }),
      deferredResult: Effect.fnUntraced(function*(deferred) {
        const instance = yield* WorkflowEngine.WorkflowInstance
        const key = `${instance.executionId}/${deferred.name}`
        const row = store.getDeferred(key)
        return row?.exit === undefined ? undefined : reviveExit(row.exit)
      }),
      deferredDone: options =>
        Effect.gen(function* () {
          const key = `${options.executionId}/${options.deferredName}`
          yield* orDieStore(store.putDeferred({
            deferredKey: key,
            workflowName: options.workflowName,
            executionId: options.executionId,
            deferredName: options.deferredName,
            exit: options.exit,
          }))
          yield* resume(options.executionId)
        }),
      scheduleClock: (workflow, options) =>
        Effect.gen(function* () {
          const key = `${options.executionId}/${options.clock.name}`
          if (store.getClockWakeup(key) !== undefined) return
          yield* orDieStore(store.putClockWakeup({
            clockKey: key,
            workflowName: workflow.name,
            executionId: options.executionId,
            clockName: options.clock.name,
            deferredName: options.clock.deferred.name,
            deadlineMs: Date.now() + Duration.toMillis(options.clock.duration),
            status: "pending",
          }))
        }),
    })

    return engine
  })
