import { type HttpClient } from "@effect/platform"
import { DurableStream } from "effect-durable-streams"
import {
  Chunk,
  Effect,
  HashMap,
  Option,
  type ParseResult,
  PubSub,
  Ref,
  Schema,
  type Scope,
  Stream,
} from "effect"
import * as P from "./Protocol.ts"
import type {
  Collection,
  CollectionWriteFailure,
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
  Upsert,
} from "./State.ts"

// ============================================================================
// Wire-format → tagged Event conversion
// ============================================================================

const toOption = <A>(v: A | undefined | null): Option.Option<A> =>
  v === undefined || v === null ? Option.none() : Option.some(v)

const toOffset = (v: string | undefined): Option.Option<DurableStream.Offset> =>
  v === undefined ? Option.none() : Option.some(DurableStream.Offset(v))

/**
 * Build a typed Event from a decoded change message. `value` must already
 * be decoded through the collection's schema by the caller (this layer is
 * pure shape-shifting; it does not validate).
 */
const buildChangeEvent = <V>(
  msg: P.ChangeMessage<unknown>,
  value: V | undefined,
  oldValue: V | undefined,
): Event<V> => {
  const txid = toOption(msg.headers.txid)
  const timestamp = toOption(msg.headers.timestamp)
  const type = msg.type
  const key = msg.key
  switch (msg.headers.operation) {
    case "insert":
      return new Insert<V>({ type, key, value: value as V, txid, timestamp })
    case "update":
      return new Update<V>({
        type,
        key,
        value: value as V,
        oldValue: toOption(oldValue),
        txid,
        timestamp,
      })
    case "upsert":
      return new Upsert<V>({ type, key, value: value as V, txid, timestamp })
    case "delete":
      return new Delete<V>({
        type,
        key,
        oldValue: toOption(oldValue),
        txid,
        timestamp,
      })
  }
}

const toControlEvent = (msg: P.ControlMessage): Event<unknown> => {
  const offset = toOffset(msg.headers.offset)
  switch (msg.headers.control) {
    case "snapshot-start":
      return new SnapshotStart({ offset })
    case "snapshot-end":
      return new SnapshotEnd({ offset })
    case "reset":
      return new Reset({ offset })
  }
}

// ============================================================================
// Per-type Collection implementation
// ============================================================================

interface CollectionImpl<V> extends Collection<V> {
  readonly _state: Ref.Ref<HashMap.HashMap<string, V>>
}

interface RegistryEntry {
  readonly schema: Schema.Schema<unknown, unknown>
  readonly decodeValue: (raw: unknown) => Effect.Effect<unknown, ParseResult.ParseError>
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
    case "State/Upsert":
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

const makeCollection = <V, VI>(
  type: string,
  schema: Schema.Schema<V, VI>,
  producer: DurableStream.Producer<P.ChangeMessage<unknown>>,
): Effect.Effect<
  { collection: CollectionImpl<V>; publish: (e: Event<V>) => Effect.Effect<void> },
  never,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const state = yield* Ref.make<HashMap.HashMap<string, V>>(HashMap.empty())
    const hub = yield* PubSub.unbounded<Event<V>>()

    const publish = (event: Event<V>): Effect.Effect<void> =>
      applyEvent(state, event).pipe(Effect.zipRight(PubSub.publish(hub, event)), Effect.asVoid)

    const encodeValue = Schema.encodeUnknown(schema)

    const writeChange = (
      operation: P.Operation,
      key: string,
      value: V | undefined,
      oldValue: V | undefined,
      opts: WriteOptions | UpdateOptions<V> | DeleteOptions<V> | undefined,
    ): Effect.Effect<void, CollectionWriteFailure, HttpClient.HttpClient> =>
      Effect.gen(function* () {
        // Encode both value and old_value through the collection's schema
        // before they hit the wire. An encode failure surfaces as a typed
        // DecodeError so the caller cannot accidentally ship a value that
        // doesn't conform to the collection's declared shape.
        const encodedValue = value === undefined
          ? undefined
          : yield* encodeValue(value).pipe(
              Effect.mapError((cause) => new DurableStream.DecodeError({ cause, raw: value })),
            )
        const encodedOldValue = oldValue === undefined
          ? undefined
          : yield* encodeValue(oldValue).pipe(
              Effect.mapError(
                (cause) => new DurableStream.DecodeError({ cause, raw: oldValue }),
              ),
            )
        const headers: P.ChangeMessage<unknown>["headers"] = {
          operation,
          ...(opts?.txid !== undefined ? { txid: opts.txid } : {}),
          ...(opts?.timestamp !== undefined ? { timestamp: opts.timestamp } : {}),
        }
        const msg: P.ChangeMessage<unknown> = {
          type,
          key,
          ...(encodedValue !== undefined ? { value: encodedValue } : {}),
          ...(encodedOldValue !== undefined ? { old_value: encodedOldValue } : {}),
          headers,
        }
        return yield* producer.append(msg)
      })

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
      upsert: (key, value, options) => writeChange("upsert", key, value, undefined, options),
      delete: (key, options) =>
        writeChange("delete", key, undefined, options?.oldValue, options),
      changes: Stream.fromPubSub(hub),
    }

    return { collection, publish }
  })

// ============================================================================
// State (multi-type container)
// ============================================================================

/**
 * Pre-registration buffer entry: a raw wire message captured in arrival
 * order so a late-registered collection can replay the full prefix of its
 * type with the correct decoding schema applied.
 *
 * Control messages are kept until the buffer ages them off — every newly
 * registered collection receives the full prefix of relevant controls so
 * snapshot/reset boundaries that arrived before registration still apply.
 */
type LogEntry =
  | { readonly kind: "change"; readonly msg: P.ChangeMessage<unknown> }
  | { readonly kind: "control"; readonly msg: P.ControlMessage }

export const make = (
  opts: MakeOptions,
): Effect.Effect<State, DurableStream.TransportError, HttpClient.HttpClient | Scope.Scope> =>
  Effect.gen(function* () {
    // The wire-format producer is parameterized by `Schema.Unknown` for the
    // value field — each per-type collection encodes through its OWN schema
    // before reaching the producer (see `makeCollection.writeChange`).
    const wireSchema = P.Message(Schema.Unknown)
    const stream = DurableStream.define({
      endpoint: opts.endpoint,
      schema: wireSchema as Schema.Schema<P.Message<unknown>, unknown>,
    })

    const producer = yield* stream.producer({
      producerId: opts.producerId,
      autoClaim: true,
    })
    // Cast to the wire-message-only view used by collections. The producer
    // accepts unknown-shaped values; per-collection encoding happens in
    // `writeChange`, so this is sound.
    const wireProducer = producer as unknown as DurableStream.Producer<P.ChangeMessage<unknown>>

    // Demux: subscribe to live reads, decode each message to an Event, and
    // dispatch to the matching collection (by type). Maintain a registry so
    // `collection()` returns the same materialization for repeated calls.
    //
    // Late-registered collections must see the full prefix of their type
    // AND of any control events that arrived before registration, in the
    // ORIGINAL arrival order (controls interleaved with typed events). The
    // previous design buffered typed events and controls separately and
    // replayed controls after — which loses the ordering between a Reset
    // and the typed events around it. The fix: a single ordered log of
    // raw wire messages, capped at `maxBufferedEvents`. On registration we
    // walk the log filtering for (this type) ∪ (all controls), in order.
    const registry = yield* Ref.make<HashMap.HashMap<string, RegistryEntry>>(HashMap.empty())
    const log = yield* Ref.make<ReadonlyArray<LogEntry>>([])
    const eventsHub = yield* PubSub.unbounded<Event<unknown>>()
    const mutex = yield* Effect.makeSemaphore(1)

    // Two caps share a single ordered log. The log records both change and
    // control entries in arrival order so a late-registered collection
    // replays its type's events INTERLEAVED with the controls that
    // happened between them — a Reset between two updates replays in the
    // correct position. Caps are enforced per-kind (per-type for changes,
    // shared for controls) to match the legacy API contract.
    const perTypeCap = opts.maxBufferedEventsPerType ?? 10_000
    const controlCap = opts.maxBufferedControlEvents ?? 1_024
    const overflowWarned = yield* Ref.make<HashMap.HashMap<string, true>>(HashMap.empty())
    const controlOverflowWarned = yield* Ref.make(false)

    /**
     * Capture the failure of the background materialization fiber so it is
     * NOT silently swallowed. Collection reads remain failure-free for
     * source-compatibility, but callers can poll `State.failure` or merge
     * `State.events` into their pipeline to observe the typed failure.
     */
    const materializationFailure =
      yield* Ref.make<Option.Option<DurableStream.ReadError>>(Option.none())

    const recordFailure = (e: DurableStream.ReadError): Effect.Effect<void> =>
      Ref.update(materializationFailure, (cur) =>
        Option.isSome(cur) ? cur : Option.some(e),
      )

    /**
     * Decode `value` and `old_value` of a change message through the
     * supplied schema decoder. Either may be absent on the wire (`undefined`
     * / `null`). Returns the decoded pair or records a materialization
     * failure if either side fails to decode.
     */
    const decodeChangePayload = (
      msg: P.ChangeMessage<unknown>,
      decode: (raw: unknown) => Effect.Effect<unknown, ParseResult.ParseError>,
    ): Effect.Effect<Option.Option<{ value: unknown; oldValue: unknown }>> =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const value = msg.value === undefined || msg.value === null
              ? undefined
              : yield* decode(msg.value)
            const oldValue = msg.old_value === undefined || msg.old_value === null
              ? undefined
              : yield* decode(msg.old_value)
            return { value, oldValue }
          }),
        )
        if (exit._tag === "Failure") {
          yield* recordFailure(
            new DurableStream.DecodeError({ cause: exit.cause, raw: msg }),
          )
          return Option.none()
        }
        return Option.some(exit.value)
      })

    /**
     * Drop the oldest entry of a given kind from the log. We can't blindly
     * drop the oldest of ANY kind because that would silently lose
     * snapshot/reset semantics when only changes overflow.
     */
    const dropOldest = (
      xs: ReadonlyArray<LogEntry>,
      predicate: (e: LogEntry) => boolean,
    ): ReadonlyArray<LogEntry> => {
      const idx = xs.findIndex(predicate)
      if (idx < 0) return xs
      return [...xs.slice(0, idx), ...xs.slice(idx + 1)]
    }

    const countWhere = (
      xs: ReadonlyArray<LogEntry>,
      predicate: (e: LogEntry) => boolean,
    ): number => {
      let n = 0
      for (const e of xs) if (predicate(e)) n++
      return n
    }

    const appendChange = (msg: P.ChangeMessage<unknown>): Effect.Effect<void> =>
      Effect.gen(function* () {
        const cap = perTypeCap
        if (!Number.isFinite(cap)) {
          yield* Ref.update(log, (xs) => [...xs, { kind: "change" as const, msg }])
          return
        }
        yield* Ref.update(log, (xs) => {
          const sameType = (e: LogEntry) =>
            e.kind === "change" && e.msg.type === msg.type
          const trimmed = countWhere(xs, sameType) >= cap ? dropOldest(xs, sameType) : xs
          return [...trimmed, { kind: "change" as const, msg }]
        })
        const currentSame = countWhere(yield* Ref.get(log), (e) =>
          e.kind === "change" && e.msg.type === msg.type,
        )
        if (currentSame >= cap) {
          const warned = yield* Ref.get(overflowWarned)
          if (Option.isNone(HashMap.get(warned, msg.type))) {
            yield* Effect.logWarning(
              `[effect-durable-streams-state] type "${msg.type}" pre-registration buffer reached ${cap} events; dropping oldest. Register collection({ type: "${msg.type}" }) earlier or raise maxBufferedEventsPerType.`,
            )
            yield* Ref.update(overflowWarned, HashMap.set(msg.type, true))
          }
        }
      })

    const appendControl = (msg: P.ControlMessage): Effect.Effect<void> =>
      Effect.gen(function* () {
        const cap = controlCap
        if (!Number.isFinite(cap)) {
          yield* Ref.update(log, (xs) => [...xs, { kind: "control" as const, msg }])
          return
        }
        yield* Ref.update(log, (xs) => {
          const isControl = (e: LogEntry) => e.kind === "control"
          const trimmed = countWhere(xs, isControl) >= cap ? dropOldest(xs, isControl) : xs
          return [...trimmed, { kind: "control" as const, msg }]
        })
        const ctrlCount = countWhere(yield* Ref.get(log), (e) => e.kind === "control")
        if (ctrlCount >= cap) {
          const warned = yield* Ref.get(controlOverflowWarned)
          if (!warned) {
            yield* Effect.logWarning(
              `[effect-durable-streams-state] pre-registration control buffer reached ${cap} entries; dropping oldest. Raise maxBufferedControlEvents if late registrations need older snapshot/reset boundaries.`,
            )
            yield* Ref.set(controlOverflowWarned, true)
          }
        }
      })

    const dispatchChange = (msg: P.ChangeMessage<unknown>): Effect.Effect<void> =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          const reg = yield* Ref.get(registry)
          const entry = HashMap.get(reg, msg.type)
          if (Option.isSome(entry)) {
            // Registered type — decode value/old_value through the
            // collection's schema before applying. A decode failure is
            // materialization-fatal (we can't trust state after a missing
            // event) and is captured via `State.failure` / `State.events`.
            const decoded = yield* decodeChangePayload(msg, entry.value.decodeValue)
            if (Option.isNone(decoded)) return
            const event = buildChangeEvent<unknown>(msg, decoded.value.value, decoded.value.oldValue)
            yield* entry.value.publish(event)
            // Publish the raw-form event (value left as wire-unknown) on
            // the multi-type events hub so observers don't need to know
            // which schema applies.
            const rawEvent = buildChangeEvent<unknown>(msg, msg.value ?? undefined, msg.old_value ?? undefined)
            yield* PubSub.publish(eventsHub, rawEvent)
          } else {
            // Unregistered type: buffer raw so a late registration can
            // decode with the correct schema.
            yield* appendChange(msg)
            const rawEvent = buildChangeEvent<unknown>(msg, msg.value ?? undefined, msg.old_value ?? undefined)
            yield* PubSub.publish(eventsHub, rawEvent)
          }
        }),
      )

    const dispatchControl = (msg: P.ControlMessage): Effect.Effect<void> =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          const event = toControlEvent(msg)
          yield* PubSub.publish(eventsHub, event)
          const reg = yield* Ref.get(registry)
          for (const e of HashMap.values(reg)) {
            yield* e.publish(event)
          }
          // Always append controls to the log: a later-registered
          // collection MUST see every prior control to track snapshot/reset
          // boundaries correctly. Controls roll off only when the dedicated
          // controlCap fills (FIFO drop of oldest control).
          yield* appendControl(msg)
        }),
      )

    const dispatch = (raw: P.Message<unknown>): Effect.Effect<void> =>
      P.isControlMessage(raw)
        ? dispatchControl(raw)
        : dispatchChange(raw)

    // Run the materialization fiber in the scope. Start at the beginning so
    // we replay history first, then follow live. Failures of the read
    // stream are CAPTURED in `materializationFailure` instead of silently
    // swallowed — collections would otherwise return stale data forever
    // after a transport/decoded failure killed the fiber.
    yield* stream
      .read({ live: true, offset: DurableStream.Offset("-1") })
      .pipe(
        Stream.runForEach((raw) => dispatch(raw)),
        Effect.catchAll((e) => recordFailure(e)),
        Effect.forkScoped,
      )

    const collection = <V, VI>(input: {
      readonly type: string
      readonly schema: Schema.Schema<V, VI>
    }): Effect.Effect<Collection<V>, SchemaConflict, HttpClient.HttpClient | Scope.Scope> =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          const reg = yield* Ref.get(registry)
          const existing = HashMap.get(reg, input.type)
          if (Option.isSome(existing)) {
            if (existing.value.schema !== (input.schema as Schema.Schema<unknown, unknown>)) {
              return yield* Effect.fail(new SchemaConflict(input.type))
            }
            return existing.value.collection as unknown as Collection<V>
          }
          const made = yield* makeCollection(input.type, input.schema, wireProducer)
          const decodeValue = Schema.decodeUnknown(input.schema) as unknown as (
            raw: unknown,
          ) => Effect.Effect<unknown, ParseResult.ParseError>
          // Walk the log in arrival order, replaying (this-type changes) ∪
          // (all controls). A decode failure during replay is captured the
          // same way as a live-stream decode failure (materialization
          // failure observable via `State.failure` / `State.events`).
          const history = yield* Ref.get(log)
          for (const entry of history) {
            if (entry.kind === "control") {
              const event = toControlEvent(entry.msg)
              yield* made.publish(event as Event<V>)
              continue
            }
            if (entry.msg.type !== input.type) continue
            const decoded = yield* decodeChangePayload(entry.msg, decodeValue)
            if (Option.isNone(decoded)) continue
            const event = buildChangeEvent<V>(
              entry.msg,
              decoded.value.value as V | undefined,
              decoded.value.oldValue as V | undefined,
            )
            yield* made.publish(event)
          }
          // Drop replayed change entries for this type — they're now
          // applied in the new collection. Keep control entries so a
          // future-registered type still sees them.
          yield* Ref.update(log, (xs) =>
            xs.filter((e) => e.kind === "control" || e.msg.type !== input.type),
          )
          yield* Ref.update(
            registry,
            HashMap.set(input.type, {
              schema: input.schema as Schema.Schema<unknown, unknown>,
              decodeValue,
              collection: made.collection as unknown as CollectionImpl<unknown>,
              publish: made.publish as (e: Event<unknown>) => Effect.Effect<void>,
            }),
          )
          return made.collection
        }),
      )

    // `events` fails when the materialization fiber records a failure, so
    // a long-running consumer can observe transport/decode death rather
    // than silently going idle. The PubSub continues to publish until that
    // moment; after a failure is recorded the merged failure stream wins.
    const eventsStream: Stream.Stream<
      Event<unknown>,
      DurableStream.ReadError,
      Scope.Scope
    > = Stream.fromPubSub(eventsHub).pipe(
      Stream.interruptWhen(
        Ref.get(materializationFailure).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.never,
              onSome: (e) => Effect.fail(e),
            }),
          ),
        ),
      ),
    )

    return {
      collection,
      events: eventsStream,
      failure: Ref.get(materializationFailure),
    } satisfies State
  })

void Chunk
