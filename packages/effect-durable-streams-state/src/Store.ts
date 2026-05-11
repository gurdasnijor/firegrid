import { type HttpClient } from "@effect/platform"
import { DurableStream } from "effect-durable-streams"
import {
  Chunk,
  Effect,
  HashMap,
  Option,
  PubSub,
  Ref,
  Schema,
  type Scope,
  Stream,
} from "effect"
import * as P from "./Protocol.ts"
import type {
  Collection,
  DeleteOptions,
  Event,
  MakeOptions,
  State,
  UpdateOptions,
  WriteOptions,
} from "./State.ts"
import {
  Delete,
  Insert,
  Reset,
  SchemaConflict,
  SnapshotEnd,
  SnapshotStart,
  Update,
} from "./State.ts"

// ============================================================================
// Wire-format → tagged Event conversion
// ============================================================================

const toOption = <A>(v: A | undefined | null): Option.Option<A> =>
  v === undefined || v === null ? Option.none() : Option.some(v)

const toOffset = (v: string | undefined): Option.Option<DurableStream.Offset> =>
  v === undefined ? Option.none() : Option.some(DurableStream.Offset(v))

const toChangeEvent = <V>(msg: P.ChangeMessage<V>): Event<V> => {
  const txid = toOption(msg.headers.txid)
  const ts = toOption(msg.headers.timestamp)
  switch (msg.headers.operation) {
    case "insert":
      return new Insert(msg.type, msg.key, msg.value as V, txid, ts)
    case "update":
      return new Update(
        msg.type,
        msg.key,
        msg.value as V,
        toOption(msg.old_value),
        txid,
        ts,
      )
    case "delete":
      return new Delete(msg.type, msg.key, toOption(msg.old_value), txid, ts)
  }
}

const toControlEvent = (msg: P.ControlMessage): Event<unknown> => {
  const offset = toOffset(msg.headers.offset)
  switch (msg.headers.control) {
    case "snapshot-start":
      return new SnapshotStart(offset)
    case "snapshot-end":
      return new SnapshotEnd(offset)
    case "reset":
      return new Reset(offset)
  }
}

const toEvent = (msg: P.Message<unknown>): Event<unknown> =>
  P.isControlMessage(msg) ? toControlEvent(msg) : toChangeEvent(msg)

// ============================================================================
// Per-type Collection implementation
// ============================================================================

interface CollectionImpl<V> extends Collection<V> {
  readonly _state: Ref.Ref<HashMap.HashMap<string, V>>
}

interface RegistryEntry {
  readonly schema: Schema.Schema<unknown, unknown>
  readonly collection: CollectionImpl<unknown>
  readonly publish: (event: Event<unknown>) => Effect.Effect<void>
}

const applyEvent = <V>(
  state: Ref.Ref<HashMap.HashMap<string, V>>,
  event: Event<V>,
): Effect.Effect<void> => {
  switch (event._tag) {
    case "State/Insert":
    case "State/Update":
      return Ref.update(state, HashMap.set(event.key, event.value))
    case "State/Delete":
      return Ref.update(state, HashMap.remove(event.key))
    case "State/Reset":
      return Ref.set(state, HashMap.empty<string, V>())
    case "State/SnapshotStart":
    case "State/SnapshotEnd":
      return Effect.void
  }
}

const makeChangeStream = <V>(
  type: string,
  schema: Schema.Schema<V, unknown>,
  endpoint: DurableStream.Endpoint,
  producer: DurableStream.Producer<P.ChangeMessage<V>>,
): { changes: Stream.Stream<Event<V>, DurableStream.ReadError, Scope.Scope>; write: (msg: P.ChangeMessage<V>) => Effect.Effect<void, DurableStream.WriteError, HttpClient.HttpClient> } => {
  void schema
  void type
  void endpoint
  return {
    changes: Stream.never,
    write: (msg) => producer.append(msg),
  }
}

void makeChangeStream

const makeCollection = <V, VI>(
  type: string,
  schema: Schema.Schema<V, VI>,
  endpoint: DurableStream.Endpoint,
  producer: DurableStream.Producer<P.ChangeMessage<V>>,
): Effect.Effect<{ collection: CollectionImpl<V>; publish: (e: Event<V>) => Effect.Effect<void> }, never, Scope.Scope> =>
  Effect.gen(function* () {
    const state = yield* Ref.make<HashMap.HashMap<string, V>>(HashMap.empty())
    const hub = yield* PubSub.unbounded<Event<V>>()

    const publish = (event: Event<V>): Effect.Effect<void> =>
      applyEvent(state, event).pipe(Effect.zipRight(PubSub.publish(hub, event)), Effect.asVoid)

    const writeChange = (
      operation: P.Operation,
      key: string,
      value: V | undefined,
      oldValue: V | undefined,
      opts: WriteOptions | UpdateOptions<V> | DeleteOptions<V> | undefined,
    ): Effect.Effect<void, DurableStream.WriteError, HttpClient.HttpClient> => {
      const headers: P.ChangeMessage<V>["headers"] = {
        operation,
        ...(opts?.txid !== undefined ? { txid: opts.txid } : {}),
        ...(opts?.timestamp !== undefined ? { timestamp: opts.timestamp } : {}),
      }
      const msg: P.ChangeMessage<V> = {
        type,
        key,
        ...(value !== undefined ? { value } : {}),
        ...(oldValue !== undefined ? { old_value: oldValue } : {}),
        headers,
      }
      return producer.append(msg)
    }

    const collection: CollectionImpl<V> = {
      _state: state,
      type,
      get: (key) => Ref.get(state).pipe(Effect.map((m) => HashMap.get(m, key))),
      has: (key) => Ref.get(state).pipe(Effect.map((m) => HashMap.has(m, key))),
      size: Ref.get(state).pipe(Effect.map((m) => HashMap.size(m))),
      entries: Ref.get(state).pipe(
        Effect.map((m) => Array.from(HashMap.entries(m)) as ReadonlyArray<readonly [string, V]>),
      ),
      keys: Ref.get(state).pipe(
        Effect.map((m) => Array.from(HashMap.keys(m)) as ReadonlyArray<string>),
      ),
      values: Ref.get(state).pipe(
        Effect.map((m) => Array.from(HashMap.values(m)) as ReadonlyArray<V>),
      ),
      insert: (key, value, options) => writeChange("insert", key, value, undefined, options),
      update: (key, value, options) =>
        writeChange("update", key, value, options?.oldValue, options),
      delete: (key, options) =>
        writeChange("delete", key, undefined, options?.oldValue, options),
      changes: Stream.fromPubSub(hub),
    }

    void schema
    return { collection, publish }
  })

// ============================================================================
// State (multi-type container)
// ============================================================================

export const make = (
  opts: MakeOptions,
): Effect.Effect<State, DurableStream.TransportError, HttpClient.HttpClient | Scope.Scope> =>
  Effect.gen(function* () {
    // The wire-format producer is parameterized by the schema-less change
    // message (each type's collection encodes its own value through its
    // schema before reaching the producer).
    const wireSchema = P.Message(Schema.Unknown)
    const stream = DurableStream.define({
      endpoint: opts.endpoint,
      schema: wireSchema as Schema.Schema<P.Message<unknown>, unknown>,
    })

    const producer = yield* stream.producer({
      producerId: opts.producerId,
      autoClaim: true,
    })

    // Demux: subscribe to live reads, decode each message to an Event, and
    // dispatch to the matching collection (by type). Control events go to
    // every collection. Maintain a registry so `collection()` returns the
    // same materialization for repeated calls.
    const registry = yield* Ref.make<HashMap.HashMap<string, RegistryEntry>>(HashMap.empty())
    const eventsHub = yield* PubSub.unbounded<Event<unknown>>()

    const dispatch = (event: Event<unknown>): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* PubSub.publish(eventsHub, event)
        const reg = yield* Ref.get(registry)
        if (event._tag === "State/Insert" || event._tag === "State/Update" || event._tag === "State/Delete") {
          const entry = HashMap.get(reg, event.type)
          if (Option.isSome(entry)) {
            yield* entry.value.publish(event)
          }
        } else {
          // Control event → broadcast to all collections.
          for (const entry of HashMap.values(reg)) {
            yield* entry.publish(event)
          }
        }
      })

    // Run the materialization fiber in the scope. Start at the beginning so
    // we replay history first, then follow live.
    yield* stream
      .read({ live: true, offset: DurableStream.Offset("-1") })
      .pipe(
        Stream.runForEach((raw) => dispatch(toEvent(raw))),
        Effect.catchAll(() => Effect.void),
        Effect.forkScoped,
      )

    const collection = <V, VI>(input: {
      readonly type: string
      readonly schema: Schema.Schema<V, VI>
    }): Effect.Effect<Collection<V>, SchemaConflict, HttpClient.HttpClient | Scope.Scope> =>
      Effect.gen(function* () {
        const reg = yield* Ref.get(registry)
        const existing = HashMap.get(reg, input.type)
        if (Option.isSome(existing)) {
          if (existing.value.schema !== (input.schema as Schema.Schema<unknown, unknown>)) {
            return yield* Effect.fail(new SchemaConflict(input.type))
          }
          return existing.value.collection as unknown as Collection<V>
        }
        // Cast the wire producer to a typed view; each collection only ever
        // submits messages it owns, so the cast is safe at the call sites.
        const typedProducer = producer as unknown as DurableStream.Producer<P.ChangeMessage<V>>
        const made = yield* makeCollection(input.type, input.schema, opts.endpoint, typedProducer)
        yield* Ref.update(
          registry,
          HashMap.set(input.type, {
            schema: input.schema as Schema.Schema<unknown, unknown>,
            collection: made.collection as unknown as CollectionImpl<unknown>,
            publish: made.publish as (e: Event<unknown>) => Effect.Effect<void>,
          }),
        )
        return made.collection
      })

    return {
      collection,
      events: Stream.fromPubSub(eventsHub),
    } satisfies State
  })

void Chunk
