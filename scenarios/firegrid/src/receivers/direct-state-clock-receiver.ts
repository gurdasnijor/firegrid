import { DurableStream } from "@durable-streams/client"
import { createStateSchema, createStreamDB } from "@durable-streams/state"
import {
  makeDurableClockDispatcher,
  makeDurableStreamClockWakeupStore,
  type DurableClockDispatcher,
} from "@firegrid/runtime/durable-clock"
import { Data, Duration, Effect, Fiber, Schedule, Schema } from "effect"
import { defineReceiverScenario } from "../definition.ts"
import { withScenarioTestServer } from "../runner.ts"

const contentType = "application/json"

const DirectScenarioJob = Schema.Struct({
  jobId: Schema.String,
  message: Schema.String,
  delayMs: Schema.Number,
  status: Schema.Literal("submitted", "running", "completed"),
  submittedAtMs: Schema.Number,
  updatedAtMs: Schema.Number,
  completedAtMs: Schema.optional(Schema.Number),
})

const DirectScenarioEvent = Schema.Struct({
  eventId: Schema.String,
  jobId: Schema.String,
  type: Schema.Literal("completed"),
  message: Schema.String,
  observedAtMs: Schema.Number,
})

type DirectScenarioJob = Schema.Schema.Type<typeof DirectScenarioJob>
type DirectScenarioEvent = Schema.Schema.Type<typeof DirectScenarioEvent>

const directScenarioState = createStateSchema({
  jobs: {
    type: "scenario.direct.job",
    primaryKey: "jobId",
    schema: Schema.standardSchemaV1(DirectScenarioJob),
  },
  events: {
    type: "scenario.direct.event",
    primaryKey: "eventId",
    schema: Schema.standardSchemaV1(DirectScenarioEvent),
  },
})

interface SubmitJobInput {
  readonly jobId: string
  readonly message: string
  readonly delayMs: number
}

interface JobIdInput {
  readonly jobId: string
}

interface CompleteJobInput {
  readonly jobId: string
  readonly observedAtMs: number
}

class ScenarioNotReady extends Data.TaggedError("ScenarioNotReady")<{
  readonly reason: string
}> {}

const nowMs = (): number => Date.now()

const appendJson = async (
  stream: { readonly append: (body: string) => Promise<unknown> },
  event: unknown,
) => {
  await stream.append(JSON.stringify(event))
}

const awaitPersisted = async (
  transaction: { readonly isPersisted: { readonly promise: Promise<unknown> } },
) => {
  await transaction.isPersisted.promise
}

const makeDirectStateDb = (streamUrl: string) =>
  createStreamDB({
    streamOptions: { url: streamUrl, contentType },
    state: directScenarioState,
    actions: ({ db, stream }) => ({
      submitJob: {
        onMutate: (input: SubmitJobInput) => {
          const at = nowMs()
          db.collections.jobs.insert({
            ...input,
            status: "submitted",
            submittedAtMs: at,
            updatedAtMs: at,
          })
        },
        mutationFn: async (input: SubmitJobInput) => {
          const at = nowMs()
          const txid = crypto.randomUUID()
          await appendJson(
            stream,
            directScenarioState.jobs.insert({
              value: {
                ...input,
                status: "submitted",
                submittedAtMs: at,
                updatedAtMs: at,
              },
              headers: { txid },
            }),
          )
          await db.utils.awaitTxId(txid)
        },
      },
      markRunning: {
        onMutate: (input: JobIdInput) => {
          db.collections.jobs.update(input.jobId, (draft) => {
            draft.status = "running"
            draft.updatedAtMs = nowMs()
          })
        },
        mutationFn: async (input: JobIdInput) => {
          const current = db.collections.jobs.get(input.jobId)
          if (current === undefined) return
          const txid = crypto.randomUUID()
          await appendJson(
            stream,
            directScenarioState.jobs.upsert({
              value: {
                ...current,
                status: "running",
                updatedAtMs: nowMs(),
              },
              headers: { txid },
            }),
          )
          await db.utils.awaitTxId(txid)
        },
      },
      completeJob: {
        onMutate: (input: CompleteJobInput) => {
          const current = db.collections.jobs.get(input.jobId)
          if (current === undefined) return
          db.collections.jobs.update(input.jobId, (draft) => {
            draft.status = "completed"
            draft.completedAtMs = input.observedAtMs
            draft.updatedAtMs = input.observedAtMs
          })
          db.collections.events.insert({
            eventId: `${input.jobId}:completed`,
            jobId: input.jobId,
            type: "completed",
            message: current.message,
            observedAtMs: input.observedAtMs,
          })
        },
        mutationFn: async (input: CompleteJobInput) => {
          const current = db.collections.jobs.get(input.jobId)
          if (current === undefined) return
          const txid = crypto.randomUUID()
          await appendJson(
            stream,
            directScenarioState.jobs.upsert({
              value: {
                ...current,
                status: "completed",
                completedAtMs: input.observedAtMs,
                updatedAtMs: input.observedAtMs,
              },
              headers: { txid },
            }),
          )
          await appendJson(
            stream,
            directScenarioState.events.insert({
              value: {
                eventId: `${input.jobId}:completed`,
                jobId: input.jobId,
                type: "completed",
                message: current.message,
                observedAtMs: input.observedAtMs,
              },
              headers: { txid },
            }),
          )
          await db.utils.awaitTxId(txid)
        },
      },
    }),
  })

type DirectStateDb = ReturnType<typeof makeDirectStateDb>

const submittedJobs = (db: DirectStateDb): ReadonlyArray<DirectScenarioJob> =>
  Array.from(db.collections.jobs.state.values())
    .filter((job) => job.status === "submitted")
    .sort((left, right) => left.submittedAtMs - right.submittedAtMs)

const processSubmittedJobs = (
  db: DirectStateDb,
  dispatcher: DurableClockDispatcher,
): Effect.Effect<void, unknown> =>
  Effect.tryPromise({
    try: async () => {
      for (const job of submittedJobs(db)) {
        await awaitPersisted(db.actions.markRunning({ jobId: job.jobId }))
        await Effect.runPromise(
          Effect.gen(function* () {
            yield* Effect.sleep(Duration.millis(job.delayMs))
            yield* Effect.tryPromise({
              try: () =>
                awaitPersisted(
                  db.actions.completeJob({
                    jobId: job.jobId,
                    observedAtMs: dispatcher.nowMs(),
                  }),
                ),
              catch: (cause) => cause,
            })
          }).pipe(Effect.provide(dispatcher.layer)),
        )
      }
    },
    catch: (cause) => cause,
  })

const runProcessorLoop = (
  db: DirectStateDb,
  dispatcher: DurableClockDispatcher,
): Effect.Effect<never, unknown> =>
  Effect.gen(function* () {
    while (true) {
      yield* processSubmittedJobs(db, dispatcher)
      yield* Effect.sleep(Duration.millis(10))
    }
  })

const runWallClockDispatcherLoop = (
  dispatcher: DurableClockDispatcher,
): Effect.Effect<never, unknown> =>
  Effect.gen(function* () {
    let lastObservedMs = nowMs()
    while (true) {
      yield* Effect.sleep(Duration.millis(10))
      const observedMs = nowMs()
      yield* dispatcher.advance(Math.max(0, observedMs - lastObservedMs))
      lastObservedMs = observedMs
    }
  })

const runDirectStateClockReceiver = (streamUrl: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const db = makeDirectStateDb(streamUrl)
      const clockStore = makeDurableStreamClockWakeupStore({ streamUrl })
      const dispatcher = makeDurableClockDispatcher({
        store: clockStore,
        initialDurableTimeMs: nowMs(),
        scope: "scenario.direct-state-clock",
      })
      return { db, clockStore, dispatcher }
    }),
    ({ db, clockStore }) =>
      Effect.sync(() => {
        db.close()
        clockStore.close()
      }),
  ).pipe(
    Effect.flatMap(({ db, dispatcher }) =>
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => db.preload(),
          catch: (cause) => cause,
        })
        yield* Effect.forkScoped(runWallClockDispatcherLoop(dispatcher))
        yield* runProcessorLoop(db, dispatcher)
      })
    ),
    Effect.scoped,
  )

const waitFor = <A>(
  effect: Effect.Effect<A, unknown>,
  predicate: (value: A) => boolean,
  reason: string,
) =>
  effect.pipe(
    Effect.filterOrFail(
      predicate,
      () => new ScenarioNotReady({ reason }),
    ),
    Effect.retry({
      times: 80,
      schedule: Schedule.spaced(Duration.millis(25)),
    }),
  )

export const selfTestDirectStateClockReceiver = () =>
  withScenarioTestServer(({ streamUrl }) =>
    Effect.gen(function* () {
      const clientDb = makeDirectStateDb(streamUrl)
      const runtimeDb = makeDirectStateDb(streamUrl)
      const clockStore = makeDurableStreamClockWakeupStore({ streamUrl })
      const dispatcher = makeDurableClockDispatcher({
        store: clockStore,
        initialDurableTimeMs: 1_000,
        scope: "scenario.direct-state-clock.self-test",
      })
      const jobId = `direct-state-clock-${crypto.randomUUID()}`

      try {
        yield* Effect.tryPromise({
          try: () => Promise.all([clientDb.preload(), runtimeDb.preload()]),
          catch: (cause) => cause,
        })

        const processorFiber = yield* Effect.forkScoped(
          runProcessorLoop(runtimeDb, dispatcher),
        )

        yield* Effect.tryPromise({
          try: () =>
            awaitPersisted(
              clientDb.actions.submitJob({
                jobId,
                message: "direct durable state plus durable clock",
                delayMs: 500,
              }),
            ),
          catch: (cause) => cause,
        })

        const pendingWakeups = yield* waitFor(
          clockStore.listPending(),
          (records) =>
            records.some((record) =>
              record.scope === "scenario.direct-state-clock.self-test" &&
              record.status === "pending"
            ),
          "durable clock wakeup was not appended",
        )

        yield* dispatcher.advance(500)

        const completedJob = yield* waitFor(
          Effect.sync(() => clientDb.collections.jobs.get(jobId)),
          (job) => job?.status === "completed",
          "job did not complete",
        )
        const event = clientDb.collections.events.get(`${jobId}:completed`)
        const clockRows = yield* clockStore.snapshot()

        yield* Fiber.interrupt(processorFiber)

        return {
          streamUrl,
          pendingWakeups,
          completedJob,
          event,
          clockRows,
        } as const
      } finally {
        clientDb.close()
        runtimeDb.close()
        clockStore.close()
      }
    }),
  )

export const directStateClockReceiverScenario = defineReceiverScenario({
  kind: "receiver",
  name: "direct-state-clock-receiver",
  run: runDirectStateClockReceiver,
  selfTest: selfTestDirectStateClockReceiver,
})
