import { DurableDeferred, Workflow, WorkflowEngine } from "@effect/workflow"
import type { Scope } from "effect"
import { Clock, Duration, Effect, Exit, Fiber, Match, Option } from "effect"
import type { DurableTableError } from "effect-durable-operators"
import { stampRowOtel, withRowOtelParent } from "@firegrid/protocol/otel"
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
        Effect.tap((claim) =>
          Effect.annotateCurrentSpan({
            "firegrid.workflow.activity.claim_worker_id": claim.workerId,
            "firegrid.workflow.activity.claim_owned": claim.workerId === workerId,
          })),
        Effect.withSpan("firegrid.workflow_engine.activity.claim", {
          kind: "internal",
          attributes: {
            "firegrid.workflow.execution_id": row.executionId,
            "firegrid.workflow.activity.name": row.activityName,
            "firegrid.workflow.activity.attempt": row.attempt,
            "firegrid.workflow.worker_id": workerId,
          },
        }),
      )

    const fireClockWakeup = (row: WorkflowClockWakeupRow) =>
      Effect.gen(function*() {
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
      }).pipe(
        Effect.withSpan("firegrid.workflow_engine.clock.fire", {
          kind: "internal",
          attributes: {
            "firegrid.workflow.execution_id": row.executionId,
            "firegrid.workflow.name": row.workflowName,
            "firegrid.workflow.clock.name": row.clockName,
          },
        }),
      )

    const scheduleClockWakeup = (row: WorkflowClockWakeupRow) =>
      Effect.gen(function*() {
        const nowMs = yield* Clock.currentTimeMillis
        yield* fireClockWakeup(row).pipe(
          Effect.delay(Duration.millis(Math.max(0, row.deadlineMs - nowMs))),
          Effect.forkIn(engineScope),
          Effect.asVoid,
        )
      }).pipe(
        Effect.withSpan("firegrid.workflow_engine.clock.schedule_wakeup", {
          kind: "internal",
          attributes: {
            "firegrid.workflow.execution_id": row.executionId,
            "firegrid.workflow.name": row.workflowName,
            "firegrid.workflow.clock.name": row.clockName,
            "firegrid.workflow.clock.deadline_ms": row.deadlineMs,
          },
        }),
      )

    const recoverPendingClockWakeups = Effect.gen(function* () {
      const pending = yield* orDieTable(table.clockWakeups.query((coll) =>
        coll.toArray.filter(row => row.status === "pending"),
      ))
      for (const row of pending) {
        yield* scheduleClockWakeup(row)
      }
    })

    const resume = (executionId: string) =>
      Effect.gen(function*() {
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
          Effect.withSpan("firegrid.workflow_engine.execution.resume.body", {
            kind: "consumer",
            attributes: {
              "firegrid.workflow.execution_id": executionId,
              "firegrid.workflow.name": row.workflowName,
            },
          }),
          // Parent the resumed workflow body (and the deferred fork beneath it)
          // back to whoever first wrote the execution row via `engine.execute`.
          // Row-scoped — runs inside the gen so `row` is in scope.
          withRowOtelParent(row),
        )
        running.set(executionId, fiber)
      }).pipe(
        Effect.withSpan("firegrid.workflow_engine.execution.resume", {
          kind: "internal",
          attributes: {
            "firegrid.workflow.execution_id": executionId,
          },
        }),
      )

    const engine = WorkflowEngine.makeUnsafe({
      register: (workflow, execute) =>
        Effect.gen(function*() {
          workflows.set(workflow.name, {
            workflow,
            execute,
            scope: yield* Effect.scope,
          })
        }).pipe(
          Effect.withSpan("firegrid.workflow_engine.workflow.register", {
            kind: "internal",
            attributes: {
              "firegrid.workflow.name": workflow.name,
            },
          }),
        ),
      execute: (workflow, options) =>
        Effect.gen(function*() {
          const existing = yield* orDieTable(table.executions.get(options.executionId).pipe(
            Effect.map(Option.getOrUndefined),
          ))
          if (existing?.finalResult !== undefined) {
            return (yield* decodeWorkflowResult(workflow, existing.finalResult)) as never
          }
          if (!existing) {
            // Stamp the caller's trace context onto the execution row so a
            // later `resume` (possibly on a different host generation) can
            // parent the workflow body span back to whoever invoked execute.
            const stamped = yield* stampRowOtel({
              executionId: options.executionId,
              workflowName: workflow.name,
              payload: options.payload,
              parentExecutionId: options.parent?.executionId,
              interrupted: false,
              suspended: false,
            })
            yield* orDieTable(table.executions.upsert(stamped))
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
        }).pipe(
          Effect.withSpan("firegrid.workflow_engine.execution.execute", {
            kind: "producer",
            attributes: {
              "firegrid.workflow.execution_id": options.executionId,
              "firegrid.workflow.name": workflow.name,
              "firegrid.workflow.discard": options.discard === true,
            },
          }),
        ),
      poll: (_workflow, executionId) =>
        Effect.gen(function* () {
          const row = yield* orDieTable(table.executions.get(executionId).pipe(
            Effect.map(Option.getOrUndefined),
          ))
          return row?.finalResult === undefined
            ? undefined
            : yield* decodeWorkflowResult(_workflow, row.finalResult)
        }).pipe(
          Effect.withSpan("firegrid.workflow_engine.execution.poll", {
            kind: "internal",
            attributes: {
              "firegrid.workflow.execution_id": executionId,
              "firegrid.workflow.name": _workflow.name,
            },
          }),
        ),
      interrupt: (_workflow, executionId) =>
        Effect.gen(function* () {
          const row = yield* orDieTable(table.executions.get(executionId).pipe(
            Effect.map(Option.getOrUndefined),
          ))
          if (!row) return
          yield* orDieTable(table.executions.upsert({ ...row, interrupted: true }))
          yield* resume(executionId)
        }).pipe(
          Effect.withSpan("firegrid.workflow_engine.execution.interrupt", {
            kind: "internal",
            attributes: {
              "firegrid.workflow.execution_id": executionId,
              "firegrid.workflow.name": _workflow.name,
            },
          }),
        ),
      resume: (_workflow, executionId) => resume(executionId),
      activityExecute: (activity, attempt) =>
        Effect.gen(function*() {
          const instance = yield* WorkflowEngine.WorkflowInstance
          yield* Effect.annotateCurrentSpan({
            "firegrid.workflow.execution_id": instance.executionId,
            "firegrid.workflow.name": instance.workflow.name,
          })
          const activityKey = `${instance.executionId}/${activity.name}/${attempt}`
          const row = yield* orDieTable(table.activities.get(activityKey).pipe(
            Effect.map(Option.getOrUndefined),
          ))
          if (row?.result !== undefined) {
            const result = reviveEncodedResult(row.result)
            if (result._tag !== "Suspended") return result
          }

          const claimedAtMs = yield* Clock.currentTimeMillis
          const claim = yield* orDieTable(claimActivity({
            claimKey: activityKey,
            executionId: instance.executionId,
            activityName: activity.name,
            attempt,
            workerId,
            claimedAtMs,
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
        }).pipe(
          Effect.withSpan("firegrid.workflow_engine.activity.execute", {
            kind: "internal",
            attributes: {
              "firegrid.workflow.activity.name": activity.name,
              "firegrid.workflow.activity.attempt": attempt,
            },
          }),
        ),
      deferredResult: deferred =>
        Effect.gen(function*() {
          const instance = yield* WorkflowEngine.WorkflowInstance
          yield* Effect.annotateCurrentSpan({
            "firegrid.workflow.execution_id": instance.executionId,
            "firegrid.workflow.name": instance.workflow.name,
          })
          const key = `${instance.executionId}/${deferred.name}`
          const row = yield* orDieTable(table.deferreds.get(key).pipe(
            Effect.map(Option.getOrUndefined),
          ))
          return row?.exit === undefined ? undefined : reviveExit(row.exit)
        }).pipe(
          Effect.withSpan("firegrid.workflow_engine.deferred.result", {
            kind: "internal",
            attributes: {
              "firegrid.workflow.deferred.name": deferred.name,
            },
          }),
        ),
      deferredDone: options =>
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan({
            "firegrid.workflow.execution_id": options.executionId,
            "firegrid.workflow.name": options.workflowName,
            "firegrid.workflow.deferred.name": options.deferredName,
          })
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
        }).pipe(
          Effect.withSpan("firegrid.workflow_engine.deferred.done", {
            kind: "internal",
          }),
        ),
      scheduleClock: (workflow, options) =>
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan({
            "firegrid.workflow.execution_id": options.executionId,
            "firegrid.workflow.name": workflow.name,
            "firegrid.workflow.clock.name": options.clock.name,
          })
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
        }).pipe(
          Effect.withSpan("firegrid.workflow_engine.clock.schedule", {
            kind: "internal",
          }),
        ),
    })

    yield* recoverPendingClockWakeups

    return engine
  })
