import { createStateSchema, createStreamDB } from "@durable-streams/state"
import { Context, Effect, Schema, Scope } from "effect"

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
          // workflow-engine-durable-state.VALIDATION.6
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

export const orDieStore = <A>(
  effect: Effect.Effect<A, WorkflowStateStoreError>,
): Effect.Effect<A> => Effect.orDie(effect)
