// Spike-only durable wake-up store.
//
// Interface intentionally shaped so a Durable Streams / State Protocol
// implementation could later satisfy it without changing callers:
//
//   appendWakeup       -> append-only durable write
//   listPending        -> retained-row read
//   listDue(nowMs)     -> filter over retained-row read
//   markDispatched     -> append a terminal/dispatched evidence row
//   cancel             -> append a cancellation evidence row
//   serialize/reload   -> the explicit round-trip used to simulate
//                         dispatcher/layer teardown + recreation
//
// The spike does NOT exercise Durable Streams here; we are only validating
// the Firegrid Clock substitution boundary.

import { Effect } from "effect"

export interface WakeupRecord {
  readonly id: string
  readonly scope: string
  readonly deadlineMs: number
  readonly appendedAtMs: number
  readonly status: "pending" | "dispatched" | "cancelled"
}

export interface AppendWakeupArgs {
  readonly id: string
  readonly scope: string
  readonly deadlineMs: number
  readonly appendedAtMs: number
}

export interface WakeupStore {
  readonly appendWakeup: (args: AppendWakeupArgs) => Effect.Effect<WakeupRecord>
  readonly listPending: () => Effect.Effect<ReadonlyArray<WakeupRecord>>
  readonly listDue: (nowMs: number) => Effect.Effect<ReadonlyArray<WakeupRecord>>
  readonly markDispatched: (id: string) => Effect.Effect<void>
  readonly cancel: (id: string) => Effect.Effect<void>
  readonly snapshot: () => ReadonlyArray<WakeupRecord>
}

export const makeInMemoryWakeupStore = (
  seed: ReadonlyArray<WakeupRecord> = [],
): WakeupStore => {
  const records: WakeupRecord[] = seed.map((r) => ({ ...r }))

  const update = (id: string, status: WakeupRecord["status"]): void => {
    const idx = records.findIndex((r) => r.id === id)
    if (idx === -1) return
    const existing = records[idx]
    if (existing === undefined) return
    records[idx] = { ...existing, status }
  }

  return {
    appendWakeup: (args) =>
      Effect.sync(() => {
        const record: WakeupRecord = { ...args, status: "pending" }
        records.push(record)
        return record
      }),
    listPending: () =>
      Effect.sync(() => records.filter((r) => r.status === "pending")),
    listDue: (nowMs) =>
      Effect.sync(() =>
        records
          .filter((r) => r.status === "pending" && r.deadlineMs <= nowMs)
          .sort((a, b) => a.deadlineMs - b.deadlineMs),
      ),
    markDispatched: (id) => Effect.sync(() => update(id, "dispatched")),
    cancel: (id) => Effect.sync(() => update(id, "cancelled")),
    snapshot: () => records.map((r) => ({ ...r })),
  }
}
