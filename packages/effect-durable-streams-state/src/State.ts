import type { DurableStream } from "effect-durable-streams"
import type { HttpClient } from "@effect/platform"
import type { Effect, Option, Schema, Scope, Stream } from "effect"

// ============================================================================
// Tagged event surface
// ============================================================================

export class Insert<V> {
  readonly _tag = "State/Insert" as const
  constructor(
    readonly type: string,
    readonly key: string,
    readonly value: V,
    readonly txid: Option.Option<string>,
    readonly timestamp: Option.Option<string>,
  ) {}
}

export class Update<V> {
  readonly _tag = "State/Update" as const
  constructor(
    readonly type: string,
    readonly key: string,
    readonly value: V,
    readonly oldValue: Option.Option<V>,
    readonly txid: Option.Option<string>,
    readonly timestamp: Option.Option<string>,
  ) {}
}

export class Delete<V> {
  readonly _tag = "State/Delete" as const
  constructor(
    readonly type: string,
    readonly key: string,
    readonly oldValue: Option.Option<V>,
    readonly txid: Option.Option<string>,
    readonly timestamp: Option.Option<string>,
  ) {}
}

export class SnapshotStart {
  readonly _tag = "State/SnapshotStart" as const
  constructor(readonly offset: Option.Option<DurableStream.Offset>) {}
}

export class SnapshotEnd {
  readonly _tag = "State/SnapshotEnd" as const
  constructor(readonly offset: Option.Option<DurableStream.Offset>) {}
}

export class Reset {
  readonly _tag = "State/Reset" as const
  constructor(readonly offset: Option.Option<DurableStream.Offset>) {}
}

export type Change<V> = Insert<V> | Update<V> | Delete<V>
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
  ) => Effect.Effect<void, DurableStream.WriteError, HttpClient.HttpClient>
  readonly update: (
    key: string,
    value: V,
    options?: UpdateOptions<V>,
  ) => Effect.Effect<void, DurableStream.WriteError, HttpClient.HttpClient>
  readonly delete: (
    key: string,
    options?: DeleteOptions<V>,
  ) => Effect.Effect<void, DurableStream.WriteError, HttpClient.HttpClient>
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
}

// Re-export the implementation entry point — see ./Store.ts
export { make } from "./Store.ts"
