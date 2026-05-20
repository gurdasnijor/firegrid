import { Effect, Stream } from "effect"

/**
 * Ephemeral client projection wait.
 *
 * Firegrid has three wait buckets:
 * - durable agent-tool waits: runtime/durable-tools wait_router + durable wait store
 *   persist WaitRow and WaitCompletionRow and survive host restart.
 * - workflow internal suspension: @effect/workflow deferreds suspend workflow bodies.
 * - ephemeral client projection waits: SDK code subscribes to a projection row stream
 *   and completes when the matching row is visible.
 *
 * Use this when an SDK call needs a control-plane projection to have caught up
 * before proceeding. NOT for agent wait_for tool plumbing (use durable
 * wait_router) or workflow body suspension (use @effect/workflow deferreds).
 */
export const projectionWait = <A, E>(
  stream: Stream.Stream<A, E>,
  predicate: (row: A) => boolean,
): Effect.Effect<void, E> =>
  stream.pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.asVoid,
  )
