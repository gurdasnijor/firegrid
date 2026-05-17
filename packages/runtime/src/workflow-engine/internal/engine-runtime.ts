import { DurableDeferred, Workflow, WorkflowEngine } from "@effect/workflow"
import type { Scope } from "effect"
import { Clock, Duration, Effect, Exit, Fiber, Match, Option } from "effect"
import type { DurableTableError } from "effect-durable-operators"
import {
  decodeWorkflowResult,
  encodeWorkflowResult,
  reviveEncodedResult,
  reviveExit,
} from "./codec.ts"
import type {
  WorkflowActivityClaimRow,
  WorkflowClockWakeupRow,
  WorkflowEngineTableService,
} from "./table.ts"

const orDieTable = <A>(
  effect: Effect.Effect<A, DurableTableError>,
): Effect.Effect<A> =>
  // workflow-engine-durable-state.ENGINE.5
  // workflow-engine-durable-state.RUNTIME_BOUNDARY.4
  // eslint-disable-next-line no-restricted-syntax -- workflow engine adapter exposes upstream WorkflowEngine APIs, which cannot carry table errors.
  Effect.orDie(effect)

export const makeWorkflowEngine = (
  table: WorkflowEngineTableService,
  workerId: string,
): Effect.Effect<WorkflowEngine.WorkflowEngine["Type"], never, Scope.Scope> =>
  Effect.gen(function* () {
    const engineScope = yield* Effect.scope
    const workflows = new Map<string, {
      workflow: Workflow.Any
      execute: (
        payload: object,
        executionId: string,
      ) => Effect.Effect<unknown, unknown, WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance>
      scope: Scope.Scope
    }>()
    const running = new Map<string, Fiber.RuntimeFiber<Workflow.Result<unknown, unknown>, never>>()

    const claimActivity = (row: WorkflowActivityClaimRow) =>
      table.activityClaims.insertOrGet(row).pipe(
        // workflow-engine-durable-state.VALIDATION.6
        // workflow-engine-durable-state.RUNTIME_BOUNDARY.5
        // firegrid-workflow-driven-runtime.PHASE_3_ACTIVITY_CLAIMS.1
        // firegrid-workflow-driven-runtime.PHASE_3_ACTIVITY_CLAIMS.2
        // firegrid-workflow-driven-runtime.PHASE_3_ACTIVITY_CLAIMS.3
        Effect.map(result =>
          Match.value(result).pipe(
            Match.tag("Inserted", () => row),
            Match.tag("Found", ({ row: existing }) => existing),
            Match.exhaustive,
          ),
        ),
      )

    const fireClockWakeup = Effect.fnUntraced(function*(row: WorkflowClockWakeupRow) {
      const current = yield* orDieTable(table.clockWakeups.get(row.clockKey).pipe(
        Effect.map(Option.getOrUndefined),
      ))
      if (!current || current.status !== "pending") return
      yield* orDieTable(table.clockWakeups.upsert({
        ...current,
        status: "fired",
      }))
      yield* engine.deferredDone(DurableDeferred.make(current.deferredName), {
        workflowName: current.workflowName,
        executionId: current.executionId,
        deferredName: current.deferredName,
        exit: Exit.void,
      })
    })

    const scheduleClockWakeup = Effect.fnUntraced(function*(row: WorkflowClockWakeupRow) {
      const nowMs = yield* Clock.currentTimeMillis
      yield* fireClockWakeup(row).pipe(
        Effect.delay(Duration.millis(Math.max(0, row.deadlineMs - nowMs))),
        Effect.forkIn(engineScope),
        Effect.asVoid,
      )
    })

    const recoverPendingClockWakeups = Effect.gen(function* () {
      const pending = yield* orDieTable(table.clockWakeups.query((coll) =>
        coll.toArray.filter(row => row.status === "pending"),
      ))
      for (const row of pending) {
        yield* scheduleClockWakeup(row)
      }
    })

    const resume = Effect.fnUntraced(function*(executionId: string) {
      const row = yield* orDieTable(table.executions.get(executionId).pipe(
        Effect.map(Option.getOrUndefined),
      ))
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
      Object.assign(instance, { interrupted: row.interrupted, cause: row.cause as typeof instance.cause })

      const fiber = yield* entry.execute(row.payload as object, executionId).pipe(
        Workflow.intoResult,
        Effect.provideService(WorkflowEngine.WorkflowInstance, instance),
        Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
        Effect.tap(result =>
          Effect.gen(function* () {
            const latest = (yield* orDieTable(table.executions.get(executionId).pipe(
              Effect.map(Option.getOrUndefined),
            ))) ?? row
            const finalResult = result._tag === "Complete"
              ? yield* encodeWorkflowResult(entry.workflow, result)
              : undefined
            yield* orDieTable(table.executions.upsert({
              ...latest,
              interrupted: instance.interrupted,
              suspended: result._tag === "Suspended", ...(result._tag === "Suspended" && result.cause !== undefined ? { cause: result.cause } : {}),
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
        const existing = yield* orDieTable(table.executions.get(options.executionId).pipe(
          Effect.map(Option.getOrUndefined),
        ))
        if (existing?.finalResult !== undefined) {
          return (yield* decodeWorkflowResult(workflow, existing.finalResult)) as never
        }
        if (!existing) {
          yield* orDieTable(table.executions.upsert({
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
        const afterResume = yield* orDieTable(table.executions.get(options.executionId).pipe(
          Effect.map(Option.getOrUndefined),
        ))
        if (afterResume?.finalResult !== undefined) {
          return (yield* decodeWorkflowResult(workflow, afterResume.finalResult)) as never
        }
        return new Workflow.Suspended({}) as never
      }),
      poll: (_workflow, executionId) =>
        Effect.gen(function* () {
          const row = yield* orDieTable(table.executions.get(executionId).pipe(
            Effect.map(Option.getOrUndefined),
          ))
          return row?.finalResult === undefined
            ? undefined
            : yield* decodeWorkflowResult(_workflow, row.finalResult)
        }),
      interrupt: (_workflow, executionId) =>
        Effect.gen(function* () {
          const row = yield* orDieTable(table.executions.get(executionId).pipe(
            Effect.map(Option.getOrUndefined),
          ))
          if (!row) return
          yield* orDieTable(table.executions.upsert({ ...row, interrupted: true }))
          yield* resume(executionId)
        }),
      resume: (_workflow, executionId) => resume(executionId),
      activityExecute: Effect.fnUntraced(function*(activity, attempt) {
        const instance = yield* WorkflowEngine.WorkflowInstance
        const activityKey = `${instance.executionId}/${activity.name}/${attempt}`
        const row = yield* orDieTable(table.activities.get(activityKey).pipe(
          Effect.map(Option.getOrUndefined),
        ))
        if (row?.result !== undefined) {
          const result = reviveEncodedResult(row.result)
          if (result._tag !== "Suspended") return result
        }

        const claim = yield* orDieTable(claimActivity({
          claimKey: activityKey,
          executionId: instance.executionId,
          activityName: activity.name,
          attempt,
          workerId,
          claimedAtMs: Date.now(),
        }))
        const completedAfterClaim = yield* orDieTable(table.activities.get(activityKey).pipe(
          Effect.map(Option.getOrUndefined),
        ))
        if (completedAfterClaim?.result !== undefined) {
          const result = reviveEncodedResult(completedAfterClaim.result)
          if (result._tag !== "Suspended") return result
        }
        if (claim.workerId !== workerId) {
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
        const existingActivity = yield* orDieTable(table.activities.get(activityKey))
        if (Option.isNone(existingActivity)) {
          yield* orDieTable(table.activities.upsert({
            activityKey,
            executionId: instance.executionId,
            activityName: activity.name,
            attempt,
            result,
          }))
        }
        return result
      }),
      deferredResult: Effect.fnUntraced(function*(deferred) {
        const instance = yield* WorkflowEngine.WorkflowInstance
        const key = `${instance.executionId}/${deferred.name}`
        const row = yield* orDieTable(table.deferreds.get(key).pipe(
          Effect.map(Option.getOrUndefined),
        ))
        return row?.exit === undefined ? undefined : reviveExit(row.exit)
      }),
      deferredDone: options =>
        Effect.gen(function* () {
          const key = `${options.executionId}/${options.deferredName}`
          const existingDeferred = yield* orDieTable(table.deferreds.get(key))
          if (Option.isNone(existingDeferred)) {
            yield* orDieTable(table.deferreds.upsert({
              deferredKey: key,
              workflowName: options.workflowName,
              executionId: options.executionId,
              deferredName: options.deferredName,
              exit: options.exit,
            }))
          }
          yield* resume(options.executionId)
        }),
      scheduleClock: (workflow, options) =>
        Effect.gen(function* () {
          // workflow-engine-durable-state.VALIDATION.3
          const key = `${options.executionId}/${options.clock.name}`
          const nowMs = yield* Clock.currentTimeMillis
          const row: WorkflowClockWakeupRow = {
            clockKey: key,
            workflowName: workflow.name,
            executionId: options.executionId,
            clockName: options.clock.name,
            deferredName: options.clock.deferred.name,
            deadlineMs: nowMs + Duration.toMillis(options.clock.duration),
            status: "pending",
          }
          const result = yield* orDieTable(table.clockWakeups.insertOrGet(row))
          yield* Match.value(result).pipe(
            Match.tag("Inserted", () => scheduleClockWakeup(row)),
            Match.tag("Found", ({ row: existing }) =>
              existing.status === "pending" && existing.deadlineMs <= nowMs
                ? scheduleClockWakeup(existing)
                : Effect.void),
            Match.exhaustive,
          )
        }),
    })

    yield* recoverPendingClockWakeups

    return engine
  })
