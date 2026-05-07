import { createStateSchema, createStreamDB } from "@durable-streams/state"
import { Clock, Deferred, Duration, Effect, Layer, Schema } from "effect"

export interface DurableClockWakeupRecord {
  readonly id: string
  readonly scope: string
  readonly deadlineMs: number
  readonly appendedAtMs: number
  readonly status: "pending" | "dispatched" | "cancelled"
}

export interface DurableClockAppendWakeupArgs {
  readonly id: string
  readonly scope: string
  readonly deadlineMs: number
  readonly appendedAtMs: number
}

// durable-clock-layer.WAKEUP_STORE.1
export interface DurableClockWakeupStore {
  readonly appendWakeup: (
    args: DurableClockAppendWakeupArgs,
  ) => Effect.Effect<DurableClockWakeupRecord, unknown>
  readonly listPending: () => Effect.Effect<
    ReadonlyArray<DurableClockWakeupRecord>,
    unknown
  >
  readonly listDue: (
    nowMs: number,
  ) => Effect.Effect<ReadonlyArray<DurableClockWakeupRecord>, unknown>
  readonly markDispatched: (id: string) => Effect.Effect<void, unknown>
  readonly cancel: (id: string) => Effect.Effect<void, unknown>
  readonly snapshot: () => Effect.Effect<
    ReadonlyArray<DurableClockWakeupRecord>,
    unknown
  >
  readonly close: () => void
}

interface PendingSleep {
  readonly id: string
  readonly deferred: Deferred.Deferred<void>
}

export interface DurableClockDispatcher {
  readonly nowMs: () => number
  readonly advance: (
    deltaMs: number,
  ) => Effect.Effect<ReadonlyArray<DurableClockWakeupRecord>>
  readonly tick: () => Effect.Effect<ReadonlyArray<DurableClockWakeupRecord>>
  readonly liveCount: () => number
  // durable-clock-layer.CLOCK_LAYER.1
  readonly layer: Layer.Layer<never>
}

export interface DurableClockDispatcherConfig {
  readonly store: DurableClockWakeupStore
  readonly initialDurableTimeMs: number
  readonly scope: string
}

export interface DurableStreamClockWakeupStoreConfig {
  readonly streamUrl: string
  readonly contentType?: string
}

const ClockWakeupRowType = "firegrid.clock.wakeup" as const

const DurableClockWakeupRecordSchema = Schema.Struct({
  id: Schema.String,
  scope: Schema.String,
  deadlineMs: Schema.Number,
  appendedAtMs: Schema.Number,
  status: Schema.Literal("pending", "dispatched", "cancelled"),
})

const clockWakeupState = createStateSchema({
  clockWakeups: {
    type: ClockWakeupRowType,
    primaryKey: "id",
    schema: Schema.standardSchemaV1(DurableClockWakeupRecordSchema),
  },
})

const pendingRecords = (
  records: ReadonlyArray<DurableClockWakeupRecord>,
): ReadonlyArray<DurableClockWakeupRecord> =>
  records.filter((record) => record.status === "pending")

// durable-clock-layer.WAKEUP_STORE.2
const dueRecords = (
  records: ReadonlyArray<DurableClockWakeupRecord>,
  nowMs: number,
): ReadonlyArray<DurableClockWakeupRecord> =>
  pendingRecords(records)
    .filter((record) => record.deadlineMs <= nowMs)
    .sort((left, right) => left.deadlineMs - right.deadlineMs)

// durable-clock-layer.CLOCK_LAYER.1
// durable-clock-layer.CLOCK_LAYER.2
export const makeDurableClockDispatcher = (
  config: DurableClockDispatcherConfig,
): DurableClockDispatcher => {
  let nowMs = config.initialDurableTimeMs
  let counter = 0
  const live = new Map<string, PendingSleep>()

  const nextId = (): string => `${config.scope}:wakeup:${++counter}`

  const fireDue: Effect.Effect<ReadonlyArray<DurableClockWakeupRecord>> =
    Effect.gen(function* () {
      const due = yield* config.store.listDue(nowMs).pipe(Effect.orDie)
      return yield* Effect.forEach(
        due,
        (record) =>
          Effect.gen(function* () {
            yield* config.store.markDispatched(record.id).pipe(Effect.orDie)
            const pending = live.get(record.id)
            if (pending !== undefined) {
              live.delete(record.id)
              yield* Deferred.succeed(pending.deferred, void 0)
            }
            return { ...record, status: "dispatched" as const }
          }),
        { discard: false },
      )
    })

  const sleep = (duration: Duration.Duration): Effect.Effect<void> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<void>()
        const id = nextId()
        const deadlineMs = nowMs + Duration.toMillis(duration)

        // durable-clock-layer.CLOCK_LAYER.3
        yield* config.store.appendWakeup({
          id,
          scope: config.scope,
          deadlineMs,
          appendedAtMs: nowMs,
        }).pipe(Effect.orDie)

        live.set(id, { id, deferred })

        if (deadlineMs <= nowMs) {
          yield* config.store.markDispatched(id).pipe(Effect.orDie)
          live.delete(id)
          return
        }

        // durable-clock-layer.CLOCK_LAYER.4
        // durable-clock-layer.CLOCK_LAYER.5
        yield* restore(Deferred.await(deferred)).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => live.delete(id)).pipe(
              Effect.flatMap((wasLive) =>
                wasLive
                  ? config.store.cancel(id).pipe(Effect.orDie)
                  : Effect.void,
              ),
            ),
          ),
        )
      }),
    )

  const clock: Clock.Clock = {
    [Clock.ClockTypeId]: Clock.ClockTypeId,
    unsafeCurrentTimeMillis: () => nowMs,
    unsafeCurrentTimeNanos: () => BigInt(Math.floor(nowMs * 1_000_000)),
    currentTimeMillis: Effect.sync(() => nowMs),
    currentTimeNanos: Effect.sync(() => BigInt(Math.floor(nowMs * 1_000_000))),
    sleep,
  }

  return {
    nowMs: () => nowMs,
    advance: (deltaMs) =>
      Effect.gen(function* () {
        nowMs += deltaMs
        return yield* fireDue
      }),
    tick: () => fireDue,
    liveCount: () => live.size,
    layer: Layer.setClock(clock),
  }
}

export const makeInMemoryDurableClockWakeupStore = (
  seed: ReadonlyArray<DurableClockWakeupRecord> = [],
): DurableClockWakeupStore => {
  const records: DurableClockWakeupRecord[] = seed.map((record) => ({
    ...record,
  }))

  const updateStatus = (
    id: string,
    status: DurableClockWakeupRecord["status"],
  ): void => {
    const index = records.findIndex((record) => record.id === id)
    if (index === -1) return
    const existing = records[index]
    if (existing === undefined) return
    records[index] = { ...existing, status }
  }

  return {
    appendWakeup: (args) =>
      Effect.sync(() => {
        const record: DurableClockWakeupRecord = {
          ...args,
          status: "pending",
        }
        records.push(record)
        return record
      }),
    listPending: () => Effect.sync(() => pendingRecords(records)),
    listDue: (nowMs) => Effect.sync(() => dueRecords(records, nowMs)),
    markDispatched: (id) =>
      Effect.sync(() => updateStatus(id, "dispatched")),
    cancel: (id) => Effect.sync(() => updateStatus(id, "cancelled")),
    snapshot: () => Effect.sync(() => records.map((record) => ({ ...record }))),
    close: () => {},
  }
}

// durable-clock-layer.WAKEUP_STORE.4
// durable-clock-layer.WAKEUP_STORE.5
export const makeDurableStreamClockWakeupStore = (
  config: DurableStreamClockWakeupStoreConfig,
): DurableClockWakeupStore => {
  const contentType = config.contentType ?? "application/json"
  const db = createStreamDB({
    streamOptions: {
      url: config.streamUrl,
      contentType,
    },
    state: clockWakeupState,
    // durable-clock-layer.WAKEUP_STORE.6
    actions: ({ db, stream }) => ({
      appendWakeup: {
        onMutate: (record: DurableClockWakeupRecord) => {
          db.collections.clockWakeups.insert(record)
        },
        mutationFn: async (record: DurableClockWakeupRecord) => {
          const txid = globalThis.crypto.randomUUID()
          await stream.append(
            JSON.stringify(
              clockWakeupState.clockWakeups.insert({
                value: record,
                headers: { txid },
              }),
            ),
          )
          await db.utils.awaitTxId(txid)
        },
      },
      setWakeupStatus: {
        onMutate: (params: {
          readonly id: string
          readonly status: DurableClockWakeupRecord["status"]
        }) => {
          db.collections.clockWakeups.update(params.id, (draft) => {
            draft.status = params.status
          })
        },
        mutationFn: async (params: {
          readonly id: string
          readonly status: DurableClockWakeupRecord["status"]
        }) => {
          const current = db.collections.clockWakeups.get(params.id)
          if (current === undefined) return
          const txid = globalThis.crypto.randomUUID()
          await stream.append(
            JSON.stringify(
              clockWakeupState.clockWakeups.upsert({
                value: { ...current, status: params.status },
                headers: { txid },
              }),
            ),
          )
          await db.utils.awaitTxId(txid)
        },
      },
    }),
  })

  let preloadPromise: Promise<void> | undefined

  const ensurePreloaded = (): Promise<void> => {
    preloadPromise ??= db.preload()
    return preloadPromise
  }

  const snapshotEffect = Effect.tryPromise({
    try: async () => {
      await ensurePreloaded()
      return Array.from(db.collections.clockWakeups.state.values())
    },
    catch: (cause) => cause,
  })

  const updateStatus = (
    id: string,
    status: DurableClockWakeupRecord["status"],
  ) =>
    Effect.tryPromise({
      try: async () => {
        await ensurePreloaded()
        const transaction = db.actions.setWakeupStatus({ id, status })
        await transaction.isPersisted.promise
      },
      catch: (cause) => cause,
    })

  return {
    appendWakeup: (args) => {
      const record: DurableClockWakeupRecord = {
        ...args,
        status: "pending",
      }
      return Effect.tryPromise({
        try: async () => {
          await ensurePreloaded()
          const transaction = db.actions.appendWakeup(record)
          await transaction.isPersisted.promise
          return record
        },
        catch: (cause) => cause,
      })
    },
    listPending: () => Effect.map(snapshotEffect, pendingRecords),
    listDue: (nowMs) =>
      Effect.map(snapshotEffect, (records) => dueRecords(records, nowMs)),
    markDispatched: (id) => updateStatus(id, "dispatched"),
    cancel: (id) => updateStatus(id, "cancelled"),
    snapshot: () => snapshotEffect,
    close: () => db.close(),
  }
}
