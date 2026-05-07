import { createStateSchema, createStreamDB } from "@durable-streams/state"
import { DurableDeferred, Workflow, WorkflowEngine } from "@effect/workflow"
import {
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schema,
  Scope,
} from "effect"

export interface WorkflowEngineDurableStateOptions {
  readonly streamUrl: string
  readonly contentType?: string
  readonly workerId?: string
  readonly txTimeoutMs?: number
}

export class WorkflowStateStoreError extends Schema.TaggedError<WorkflowStateStoreError>()(
  "WorkflowStateStoreError",
  {
    op: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export const WorkflowExecutionRowSchema = Schema.Struct({
  executionId: Schema.String,
  workflowName: Schema.String,
  payload: Schema.Unknown,
  parentExecutionId: Schema.optional(Schema.String),
  interrupted: Schema.Boolean,
  suspended: Schema.Boolean,
  finalResult: Schema.optional(Schema.Unknown),
})
export type WorkflowExecutionRow = Schema.Schema.Type<typeof WorkflowExecutionRowSchema>

export const WorkflowActivityRowSchema = Schema.Struct({
  activityKey: Schema.String,
  executionId: Schema.String,
  activityName: Schema.String,
  attempt: Schema.Number,
  result: Schema.Unknown,
})
export type WorkflowActivityRow = Schema.Schema.Type<typeof WorkflowActivityRowSchema>

export const WorkflowActivityClaimRowSchema = Schema.Struct({
  claimKey: Schema.String,
  executionId: Schema.String,
  activityName: Schema.String,
  attempt: Schema.Number,
  workerId: Schema.String,
  claimedAtMs: Schema.Number,
})
export type WorkflowActivityClaimRow = Schema.Schema.Type<typeof WorkflowActivityClaimRowSchema>

export const WorkflowDeferredRowSchema = Schema.Struct({
  deferredKey: Schema.String,
  workflowName: Schema.String,
  executionId: Schema.String,
  deferredName: Schema.String,
  exit: Schema.Unknown,
})
export type WorkflowDeferredRow = Schema.Schema.Type<typeof WorkflowDeferredRowSchema>

export const WorkflowClockWakeupRowSchema = Schema.Struct({
  clockKey: Schema.String,
  workflowName: Schema.String,
  executionId: Schema.String,
  clockName: Schema.String,
  deferredName: Schema.String,
  deadlineMs: Schema.Number,
  status: Schema.Literal("pending", "fired"),
})
export type WorkflowClockWakeupRow = Schema.Schema.Type<typeof WorkflowClockWakeupRowSchema>

export const workflowStateSchema = createStateSchema({
  executions: {
    type: "workflow.execution",
    primaryKey: "executionId",
    schema: Schema.standardSchemaV1(WorkflowExecutionRowSchema),
  },
  activities: {
    type: "workflow.activity",
    primaryKey: "activityKey",
    schema: Schema.standardSchemaV1(WorkflowActivityRowSchema),
  },
  activityClaims: {
    type: "workflow.activity_claim",
    primaryKey: "claimKey",
    schema: Schema.standardSchemaV1(WorkflowActivityClaimRowSchema),
  },
  deferreds: {
    type: "workflow.deferred",
    primaryKey: "deferredKey",
    schema: Schema.standardSchemaV1(WorkflowDeferredRowSchema),
  },
  clockWakeups: {
    type: "workflow.clock_wakeup",
    primaryKey: "clockKey",
    schema: Schema.standardSchemaV1(WorkflowClockWakeupRowSchema),
  },
})

export interface WorkflowStateStore {
  readonly workerId: string
  readonly getExecution: (executionId: string) => WorkflowExecutionRow | undefined
  readonly putExecution: (row: WorkflowExecutionRow) => Effect.Effect<void, WorkflowStateStoreError>
  readonly getActivity: (activityKey: string) => WorkflowActivityRow | undefined
  readonly putActivity: (row: WorkflowActivityRow) => Effect.Effect<void, WorkflowStateStoreError>
  readonly claimActivity: (row: WorkflowActivityClaimRow) => Effect.Effect<WorkflowActivityClaimRow, WorkflowStateStoreError>
  readonly activityClaims: () => ReadonlyArray<WorkflowActivityClaimRow>
  readonly getDeferred: (deferredKey: string) => WorkflowDeferredRow | undefined
  readonly putDeferred: (row: WorkflowDeferredRow) => Effect.Effect<void, WorkflowStateStoreError>
  readonly getClockWakeup: (clockKey: string) => WorkflowClockWakeupRow | undefined
  readonly putClockWakeup: (row: WorkflowClockWakeupRow) => Effect.Effect<void, WorkflowStateStoreError>
  readonly pendingClockWakeups: () => ReadonlyArray<WorkflowClockWakeupRow>
  readonly close: Effect.Effect<void>
}

export const WorkflowStateStore = Context.GenericTag<WorkflowStateStore>(
  "firegrid/runtime/WorkflowStateStore",
)

const promiseOp = <A>(
  op: string,
  promise: () => Promise<A>,
): Effect.Effect<A, WorkflowStateStoreError> =>
  Effect.tryPromise({
    try: promise,
    catch: cause => new WorkflowStateStoreError({ op, cause }),
  })

export const makeWorkflowStateStore = (
  options: WorkflowEngineDurableStateOptions,
): Effect.Effect<WorkflowStateStore, WorkflowStateStoreError> =>
  Effect.gen(function* () {
    const txTimeoutMs = options.txTimeoutMs ?? 2_000
    const workerId = options.workerId ?? `worker-${crypto.randomUUID()}`
    const db = createStreamDB({
      streamOptions: {
        url: options.streamUrl,
        contentType: options.contentType ?? "application/json",
      },
      state: workflowStateSchema,
      actions: ({ db, stream }) => ({
        putExecution: {
          onMutate: (row: WorkflowExecutionRow) => {
            const existing = db.collections.executions.get(row.executionId)
            if (existing === undefined) {
              db.collections.executions.insert(row)
            } else {
              db.collections.executions.update(row.executionId, draft => {
                Object.assign(draft, row)
              })
            }
          },
          mutationFn: async (row: WorkflowExecutionRow) => {
            const txid = crypto.randomUUID()
            await stream.append(JSON.stringify(workflowStateSchema.executions.upsert({
              value: row,
              headers: { txid },
            })))
            await db.utils.awaitTxId(txid, txTimeoutMs)
          },
        },
        putActivity: {
          onMutate: (row: WorkflowActivityRow) => {
            if (db.collections.activities.get(row.activityKey) === undefined) {
              db.collections.activities.insert(row)
            }
          },
          mutationFn: async (row: WorkflowActivityRow) => {
            const txid = crypto.randomUUID()
            await stream.append(JSON.stringify(workflowStateSchema.activities.upsert({
              value: row,
              headers: { txid },
            })))
            await db.utils.awaitTxId(txid, txTimeoutMs)
          },
        },
        putDeferred: {
          onMutate: (row: WorkflowDeferredRow) => {
            if (db.collections.deferreds.get(row.deferredKey) === undefined) {
              db.collections.deferreds.insert(row)
            }
          },
          mutationFn: async (row: WorkflowDeferredRow) => {
            const txid = crypto.randomUUID()
            await stream.append(JSON.stringify(workflowStateSchema.deferreds.upsert({
              value: row,
              headers: { txid },
            })))
            await db.utils.awaitTxId(txid, txTimeoutMs)
          },
        },
        putClockWakeup: {
          onMutate: (row: WorkflowClockWakeupRow) => {
            const existing = db.collections.clockWakeups.get(row.clockKey)
            if (existing === undefined) {
              db.collections.clockWakeups.insert(row)
            } else {
              db.collections.clockWakeups.update(row.clockKey, draft => {
                Object.assign(draft, row)
              })
            }
          },
          mutationFn: async (row: WorkflowClockWakeupRow) => {
            const txid = crypto.randomUUID()
            await stream.append(JSON.stringify(workflowStateSchema.clockWakeups.upsert({
              value: row,
              headers: { txid },
            })))
            await db.utils.awaitTxId(txid, txTimeoutMs)
          },
        },
      }),
    })

    yield* promiseOp("preload", () => db.preload())

    return {
      workerId,
      getExecution: executionId => db.collections.executions.get(executionId),
      putExecution: row =>
        promiseOp("putExecution", async () => {
          await db.actions.putExecution(row).isPersisted.promise
        }),
      getActivity: activityKey => db.collections.activities.get(activityKey),
      putActivity: row =>
        promiseOp("putActivity", async () => {
          if (db.collections.activities.get(row.activityKey) !== undefined) return
          await db.actions.putActivity(row).isPersisted.promise
        }),
      claimActivity: row =>
        promiseOp("claimActivity", async () => {
          const existing = db.collections.activityClaims.get(row.claimKey)
          if (existing !== undefined) return existing
          const txid = `workflow-activity-claim:${row.claimKey}`
          await db.stream.append(
            JSON.stringify(workflowStateSchema.activityClaims.upsert({
              value: row,
              headers: { txid },
            })),
            {
              seq: `workflow-activity-claim:${row.claimKey}`,
              producerId: `workflow-activity-claim:${row.claimKey}`,
              producerEpoch: 0,
              producerSeq: 0,
            },
          ).catch(async () => {
            await db.preload()
          })
          if (db.collections.activityClaims.get(row.claimKey) === undefined) {
            await db.utils.awaitTxId(txid, txTimeoutMs)
          }
          await db.preload()
          const claim = db.collections.activityClaims.get(row.claimKey)
          if (claim !== undefined) return claim
          throw new Error(`activity claim not materialized: ${row.claimKey}`)
        }),
      activityClaims: () => Array.from(db.collections.activityClaims.state.values()),
      getDeferred: deferredKey => db.collections.deferreds.get(deferredKey),
      putDeferred: row =>
        promiseOp("putDeferred", async () => {
          if (db.collections.deferreds.get(row.deferredKey) !== undefined) return
          await db.actions.putDeferred(row).isPersisted.promise
        }),
      getClockWakeup: clockKey => db.collections.clockWakeups.get(clockKey),
      putClockWakeup: row =>
        promiseOp("putClockWakeup", async () => {
          await db.actions.putClockWakeup(row).isPersisted.promise
        }),
      pendingClockWakeups: () =>
        Array.from(db.collections.clockWakeups.state.values()).filter(
          row => row.status === "pending",
        ),
      close: Effect.sync(() => db.close()),
    }
  })

export const acquireWorkflowStateStore = (
  options: WorkflowEngineDurableStateOptions,
): Effect.Effect<WorkflowStateStore, WorkflowStateStoreError, Scope.Scope> =>
  Effect.acquireRelease(
    makeWorkflowStateStore(options),
    store => store.close,
  )

const orDieStore = <A>(
  effect: Effect.Effect<A, WorkflowStateStoreError>,
): Effect.Effect<A> => Effect.orDie(effect)

const decodeWorkflowResult = (
  workflow: Workflow.Any,
  value: unknown,
): Effect.Effect<Workflow.Result<unknown, unknown>> =>
  Schema.decodeUnknown(Workflow.Result({
    success: workflow.successSchema,
    error: workflow.errorSchema,
  }))(value) as Effect.Effect<Workflow.Result<unknown, unknown>>

const encodeWorkflowResult = (
  workflow: Workflow.Any,
  value: Workflow.Result<unknown, unknown>,
): Effect.Effect<unknown> =>
  Schema.encode(Workflow.Result({
    success: workflow.successSchema,
    error: workflow.errorSchema,
  }))(value as never) as Effect.Effect<unknown>

const reviveExit = (value: unknown): Exit.Exit<unknown, unknown> => {
  const record = value as { _tag?: string; value?: unknown }
  if (record?._tag === "Success") return Exit.succeed(record.value)
  return value as Exit.Exit<unknown, unknown>
}

const reviveEncodedResult = (value: unknown): Workflow.Result<unknown, unknown> => {
  const record = value as { _tag?: string; exit?: unknown }
  if (record._tag === "Suspended") {
    return new Workflow.Suspended({})
  }
  if (record._tag === "Complete") {
    return new Workflow.Complete({ exit: reviveExit(record.exit) })
  }
  return value as Workflow.Result<unknown, unknown>
}

const makeWorkflowEngine = (
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

export const layerDurableStreams = (
  options: WorkflowEngineDurableStateOptions,
) =>
  Layer.scopedContext(
    Effect.gen(function* () {
      // workflow-engine-durable-state.ENGINE.1
      const store = yield* acquireWorkflowStateStore(options)
      const engine = yield* makeWorkflowEngine(store)
      return Context.make(WorkflowStateStore, store).pipe(
        Context.add(WorkflowEngine.WorkflowEngine, engine),
      )
    }),
  )

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
