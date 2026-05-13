import { Workflow, WorkflowEngine } from "@effect/workflow"
import { FetchHttpClient } from "@effect/platform"
import type { Scope } from "effect"
import { Duration, Effect, Fiber, Option, Schema } from "effect"
import { DurableTableError, type DurableTableHeaders } from "effect-durable-operators"
import { DurableStream } from "effect-durable-streams"
import {
  decodeWorkflowResult,
  encodeWorkflowResult,
  reviveEncodedResult,
  reviveExit,
} from "./codec.ts"
import type {
  WorkflowActivityClaimRow,
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
  streamUrl: string,
  workerId: string,
  headers: DurableTableHeaders | undefined,
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

    const appendActivityClaimInsert = (
      row: WorkflowActivityClaimRow,
    ) =>
      // workflow-engine-durable-state.RUNTIME_BOUNDARY.5
      // workflow-engine-durable-state.RUNTIME_BOUNDARY.6
      DurableStream.define({
        endpoint: {
          url: streamUrl,
          ...(headers !== undefined ? { headers } : {}),
        },
        schema: Schema.Unknown,
      }).producer({
        producerId: `firegrid.workflow.activityClaim:${row.claimKey}`,
        lingerMs: 0,
      }).pipe(
        Effect.flatMap(producer =>
          producer.append({
            type: "firegrid.workflow.activityClaims",
            key: row.claimKey,
            value: row,
            headers: {
              operation: "insert",
              txid: `firegrid.workflow.activityClaim:${row.claimKey}`,
            },
          }).pipe(Effect.zipRight(producer.flush)),
        ),
        Effect.provide(FetchHttpClient.layer),
        Effect.scoped,
      )

    const waitForActivityClaim = (
      claimKey: string,
      remaining: number,
    ): Effect.Effect<WorkflowActivityClaimRow | undefined, DurableTableError> =>
      table.activityClaims.get(claimKey).pipe(
        Effect.flatMap(existing => {
          if (Option.isSome(existing) || remaining <= 0) {
            return Effect.succeed(Option.getOrUndefined(existing))
          }
          return Effect.sleep("10 millis").pipe(
            Effect.zipRight(waitForActivityClaim(claimKey, remaining - 1)),
          )
        }),
      )

    const claimActivity = (row: WorkflowActivityClaimRow) =>
      Effect.gen(function* () {
        // workflow-engine-durable-state.VALIDATION.6
        // workflow-engine-durable-state.RUNTIME_BOUNDARY.5
        const existing = yield* table.activityClaims.get(row.claimKey).pipe(
          Effect.map(Option.getOrUndefined),
        )
        if (existing !== undefined) return existing
        yield* appendActivityClaimInsert(row).pipe(
          Effect.mapError(cause => new DurableTableError({
            table: "firegrid.workflow.activityClaims",
            cause,
          })),
        )
        const afterRace = yield* waitForActivityClaim(row.claimKey, 200)
        if (afterRace !== undefined) return afterRace
        return row
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
      instance.interrupted = row.interrupted

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
          const key = `${options.executionId}/${options.clock.name}`
          if (Option.isSome(yield* orDieTable(table.clockWakeups.get(key)))) return
          yield* orDieTable(table.clockWakeups.upsert({
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
