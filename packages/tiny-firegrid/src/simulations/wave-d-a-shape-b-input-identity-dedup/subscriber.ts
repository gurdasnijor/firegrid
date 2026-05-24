// Wave D-A Shape (b) — subscriber composition.
//
// The loop body the production cutover lands at:
//
//   runKeyedDispatch({
//     source: merge(inputFactsForContext, outputsForContext).map({ key, event }),
//     handle: identityKeyedHandler,
//     concurrency: "unbounded",
//   })
//
// `runKeyedDispatch` is the production primitive at
// `packages/runtime/src/subscribers/keyed-dispatch/keyed-dispatch.ts`. It owns
// per-key FIFO via a per-key mutex and cross-key concurrency via the bounded
// `Stream.mapEffect`. No `WorkflowEngine` requirement is added — Shape C
// purity per `keyed-dispatch.ts:18-25`.
//
// The sim drives `runKeyedDispatch` on a forked fiber; tests append inputs/
// outputs to the substrate's SubscriptionRefs and interrupt the fiber when
// the assertion conditions hold. Mirrors the
// `shape-c-non-recursive-start/probe.test.ts` driver pattern.

import { Stream, type Effect } from "effect"
import { runKeyedDispatch } from "@firegrid/runtime/subscribers/keyed-dispatch"
import {
  inputFactsForContext,
  outputsForContext,
  type RuntimeContextTargetEvent,
  type Substrate,
} from "./resources.ts"

/**
 * The keyed source: per-context inputs + outputs merged, tagged, and emitted
 * as `{ key: contextId, event: RuntimeContextTargetEvent }`.
 *
 * The sim's source is bounded to a single contextId in each test scenario
 * (or two for the cross-key concurrency test). Production merges all
 * per-context tails into one stream of `{ key, event }` by binding the
 * sources per-contextId at composition time.
 */
export const mergedKeyedSource = (
  substrate: Substrate,
  contextId: string,
): Stream.Stream<{ readonly key: string; readonly event: RuntimeContextTargetEvent }> => {
  const inputs = inputFactsForContext(substrate, contextId).pipe(
    Stream.map((event): RuntimeContextTargetEvent => ({ _tag: "Input", event })),
  )
  const outputs = outputsForContext(substrate, contextId).pipe(
    Stream.map((event): RuntimeContextTargetEvent => ({ _tag: "Output", event })),
  )
  return Stream.merge(inputs, outputs).pipe(
    Stream.map((event) => ({ key: contextId, event })),
  )
}

/**
 * Multi-context keyed source. Used by the cross-key concurrency test.
 */
export const mergedKeyedSourceMulti = (
  substrate: Substrate,
  contextIds: ReadonlyArray<string>,
): Stream.Stream<{ readonly key: string; readonly event: RuntimeContextTargetEvent }> =>
  contextIds
    .map((contextId) => mergedKeyedSource(substrate, contextId))
    .reduce((acc, s) => Stream.merge(acc, s), Stream.empty as Stream.Stream<{
      readonly key: string
      readonly event: RuntimeContextTargetEvent
    }>)

/**
 * Run the Shape (b) subscriber. Returns when `source` ends; in the sim, the
 * source never ends on its own — tests interrupt the host fiber after
 * assertions hold.
 */
export const runShapeBSubscriber = (
  substrate: Substrate,
  contextId: string,
  handle: (key: string, event: RuntimeContextTargetEvent) => Effect.Effect<void>,
): Effect.Effect<void> =>
  runKeyedDispatch({
    source: mergedKeyedSource(substrate, contextId),
    handle,
  })

export const runShapeBSubscriberMulti = (
  substrate: Substrate,
  contextIds: ReadonlyArray<string>,
  handle: (key: string, event: RuntimeContextTargetEvent) => Effect.Effect<void>,
): Effect.Effect<void> =>
  runKeyedDispatch({
    source: mergedKeyedSourceMulti(substrate, contextIds),
    handle,
  })
