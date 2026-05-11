import type { DurableStream } from "effect-durable-streams"
import type { HttpClient } from "@effect/platform"
import { Data, type Effect, type Option, type Schema, type Scope, type Stream } from "effect"

// ============================================================================
// Tagged event surface — Data.TaggedClass-based for terse declarations and
// idiomatic Match.tag interop.
// ============================================================================

interface ChangeBase<V> {
  readonly type: string
  readonly key: string
  readonly value: V
  readonly txid: Option.Option<string>
  readonly timestamp: Option.Option<string>
}

export class Insert<V> extends Data.TaggedClass("State/Insert")<ChangeBase<V>> {}

export class Update<V> extends Data.TaggedClass("State/Update")<
  ChangeBase<V> & { readonly oldValue: Option.Option<V> }
> {}

export class Upsert<V> extends Data.TaggedClass("State/Upsert")<ChangeBase<V>> {}

export class Delete<V> extends Data.TaggedClass("State/Delete")<{
  readonly type: string
  readonly key: string
  readonly oldValue: Option.Option<V>
  readonly txid: Option.Option<string>
  readonly timestamp: Option.Option<string>
}> {}

interface ControlBase {
  readonly offset: Option.Option<DurableStream.Offset>
}

export class SnapshotStart extends Data.TaggedClass("State/SnapshotStart")<ControlBase> {}
export class SnapshotEnd extends Data.TaggedClass("State/SnapshotEnd")<ControlBase> {}

export class Reset extends Data.TaggedClass("State/Reset")<ControlBase> {}

export type Change<V> = Insert<V> | Update<V> | Upsert<V> | Delete<V>
export type Control = SnapshotStart | SnapshotEnd | Reset
export type Event<V> = Change<V> | Control

// ============================================================================
// Public types
// ============================================================================

export interface WriteOptions {
  readonly txid?: string
  readonly timestamp?: string
}

export interface UpdateOptions<V> extends WriteOptions {
  readonly oldValue?: V
}

export interface DeleteOptions<V> extends WriteOptions {
  readonly oldValue?: V
}

export class SchemaConflict {
  readonly _tag = "State/SchemaConflict" as const
  constructor(readonly type: string) {}
}

export interface Collection<V> {
  readonly type: string
  readonly get: (key: string) => Effect.Effect<Option.Option<V>>
  readonly has: (key: string) => Effect.Effect<boolean>
  readonly size: Effect.Effect<number>
  readonly entries: Effect.Effect<ReadonlyArray<readonly [string, V]>>
  readonly keys: Effect.Effect<ReadonlyArray<string>>
  readonly values: Effect.Effect<ReadonlyArray<V>>
  readonly insert: (
    key: string,
    value: V,
    options?: WriteOptions,
  ) => Effect.Effect<void, DurableStream.ProducerFailure, HttpClient.HttpClient>
  readonly update: (
    key: string,
    value: V,
    options?: UpdateOptions<V>,
  ) => Effect.Effect<void, DurableStream.ProducerFailure, HttpClient.HttpClient>
  /**
   * Insert-or-update: applies the value regardless of whether the key
   * already exists. Materializes as `HashMap.set`; emits a `Upsert` event.
   */
  readonly upsert: (
    key: string,
    value: V,
    options?: WriteOptions,
  ) => Effect.Effect<void, DurableStream.ProducerFailure, HttpClient.HttpClient>
  readonly delete: (
    key: string,
    options?: DeleteOptions<V>,
  ) => Effect.Effect<void, DurableStream.ProducerFailure, HttpClient.HttpClient>
  readonly changes: Stream.Stream<Event<V>, DurableStream.ReadError, Scope.Scope>
}

export interface State {
  readonly collection: <V, VI>(opts: {
    readonly type: string
    readonly schema: Schema.Schema<V, VI>
  }) => Effect.Effect<Collection<V>, SchemaConflict, HttpClient.HttpClient | Scope.Scope>
  readonly events: Stream.Stream<Event<unknown>, DurableStream.ReadError, Scope.Scope>
}

export interface MakeOptions {
  readonly endpoint: DurableStream.Endpoint
  readonly producerId: string
  /**
   * Cap on the per-type buffer of events received before `collection()`
   * registers that type. Prevents unbounded memory growth if a State
   * instance is created but `collection()` is never called for some types.
   * On overflow the OLDEST event is dropped (FIFO) and a warning is logged
   * once per type. Defaults to 10_000 events per type.
   *
   * Set to `Infinity` to disable.
   */
  readonly maxBufferedEventsPerType?: number

  /**
   * Cap on the buffered `controlLog` (snapshot-start / snapshot-end / reset
   * events) for replay into late-registered collections. Defaults to 1_024.
   */
  readonly maxBufferedControlEvents?: number
}

// Re-export the implementation entry point — see ./Store.ts
export { make } from "./Store.ts"
