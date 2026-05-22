import { Effect, Stream } from "effect"
import { makePerKeyMutex } from "./per-key-mutex.ts"

// Shape C dispatcher: drives per-event handler materializations from a tail
// source, with in-key serialization and cross-key concurrency. The handler
// owns durable state (e.g. `RuntimeContextStateStore`); the dispatcher does
// not. Between events the entity IS its durable state row (C2 / C5 of
// `runtime-design-constraints.md` — no parked entity body).
//
// This is the production manifestation of the tf-4fy3 finding (Outcome B
// evidence): substrate push + crash recovery are native, but per-key
// serialization with cross-key concurrency requires a thin subscriber-runtime
// layer. THIS module is that layer.
//
// Invariants enforced here:
//   - same `key` => handlers serialized FIFO (via per-key mutex).
//   - different `key` => handlers run concurrently (up to `concurrency`).
//   - no polling: `source` is the entire wakeup surface; if `source` ends,
//     dispatch ends.
//   - no entity-lifetime parked body: each handler call returns before the
//     next event for that key is dispatched.
//   - no workflow machinery in `R`: the dispatcher itself imposes no
//     `WorkflowEngine` / `WorkflowInstance` requirement. If a handler's `R`
//     adds one, that is a Shape D escalation that the call site declares.

/**
 * A single keyed event off the source stream. `key` selects the durable state
 * container; `event` is the typed fact the handler applies.
 */
export interface KeyedEvent<K, E> {
  readonly key: K
  readonly event: E
}

export interface RunKeyedDispatchOptions<K, E, Err, R> {
  /**
   * The keyed-event source. Should be a replay-then-tail subscription over the
   * durable rows the subscriber owns (e.g. merged input / output / tool-result
   * tails projected to `{ key: contextId, event: RuntimeContextTargetEvent }`).
   * Restart semantics come from this stream's `includeInitialState` behavior
   * combined with the handler reloading state from its store on every
   * materialization. The dispatcher itself is stateless.
   */
  readonly source: Stream.Stream<KeyedEvent<K, E>, Err, R>
  /**
   * Per-event handler. Materializes for `(key, event)`, applies the transition
   * (load state, transition, save state, dispatch actions), and returns. Must
   * not park, must not span the entity's lifetime, must not read the source
   * stream itself.
   */
  readonly handle: (key: K, event: E) => Effect.Effect<void, Err, R>
  /**
   * Upper bound on cross-key in-flight handler materializations. Defaults to
   * `"unbounded"`. The per-key mutex still pins in-key concurrency to 1
   * regardless of this setting; this only bounds how many DIFFERENT keys can
   * progress at the same time. Note: if a single key produces a long backlog,
   * a bounded `concurrency` value can be temporarily occupied by handlers
   * waiting on that key's permit, starving other keys until the head completes.
   * For RuntimeContext usage that is acceptable; downstream lanes that need
   * stricter fairness can compose their own scheduler around this primitive.
   */
  readonly concurrency?: number | "unbounded"
}

/**
 * Run the keyed dispatcher. Returns an Effect that drains `source`, dispatches
 * each event under the per-key mutex with the requested cross-key concurrency,
 * and completes when `source` ends. Errors from the source or any handler
 * surface in the result's `Err` channel.
 *
 * The `R` channel is the UNION of `source`'s and `handle`'s requirements; the
 * dispatcher adds none of its own. This means the dispatcher is Shape-neutral:
 * it never forces `WorkflowEngine` into a subscriber's `R`.
 */
export const runKeyedDispatch = <K, E, Err, R>(
  options: RunKeyedDispatchOptions<K, E, Err, R>,
): Effect.Effect<void, Err, R> =>
  Effect.gen(function*() {
    const mutex = yield* makePerKeyMutex<K>()
    const concurrency = options.concurrency ?? "unbounded"
    return yield* options.source.pipe(
      Stream.mapEffect(
        ({ key, event }) =>
          mutex.withKey(key, options.handle(key, event)),
        { concurrency },
      ),
      Stream.runDrain,
    )
  })
