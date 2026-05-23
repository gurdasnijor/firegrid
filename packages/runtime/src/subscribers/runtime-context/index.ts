// Wave D-A Shape (b) — RuntimeContext per-event subscriber composition.
//
// SHAPE: C. This Layer is the Shape (b) loop body proven GREEN by the
// tiny-firegrid simulation `wave-d-a-shape-b-input-identity-dedup` (#712).
// It forks `runKeyedDispatch({source: merge(inputs, outputs), handle:
// handleRuntimeContextEvent})` onto the Layer's scope so the dispatcher
// dies when host composition tears down.
//
// Source composition (no new primitive — all building blocks pre-exist):
//
//   inputs  : `RuntimeContextInputFacts.forContext(contextId)` per discovered
//             context. The service tails `RuntimeControlPlaneTable.inputIntents`
//             (intent-derived rows; identity = `inputId === intent.intentId`,
//             no sequence allocator).
//   outputs : `RuntimeAgentOutputAfterEvents.forContext(contextId)` per
//             discovered context. The service tails the per-context
//             `RuntimeOutputTable` and decodes to
//             `RuntimeAgentOutputObservation` (kernel-allocated sequence
//             retained — output dedup stays sequence-keyed).
//   keys    : `RuntimeContexts` stream provides context discovery; the
//             dispatcher fans out per-context substreams via
//             `Stream.flatMap` with `concurrency: "unbounded"`.
//   handler : `handleRuntimeContextEvent(context, activityAttempt, event)`.
//             `context` is resolved via `RuntimeContextRead.readContext`;
//             `activityAttempt` is read via
//             `RuntimeRunAppendAndGet.latestStartedAttempt(contextId)`
//             per the Q2 directive — typed authority service, never a
//             raw table-service yield.
//
// Hard rules (per `subscribers/runtime-context/README.md` + the cutover
// directives):
//   - No `WorkflowEngine` / `WorkflowInstance` / `Activity.make` in the
//     subscriber `R` channel (the dispatcher is Shape-neutral per
//     `runtime-keyed-subscriber/keyed-dispatch.ts:18-25`).
//   - No raw `DurableTable` service yield in `subscribers/` — table
//     binding lives in `tables/` + `authorities/`; subscribers consume
//     typed source/authority capabilities (enforced by
//     `firegrid-runtime-no-table-service-yield-outside-providers` +
//     `firegrid-runtime-no-table-type-parameters-outside-authorities`).
//   - No new runner/driver/generic stream — `runKeyedDispatch` is reused
//     verbatim; `Stream.flatMap` over discovered contexts is the per-key
//     fan-in.
//   - Identity-keyed input dedup is enforced inside
//     `handleRuntimeContextEvent` via the `processedInputIds` membership
//     test (#712 verdict). Restart idempotency comes from the durable state
//     row being reloaded on every handler materialization.

import { Effect, Layer, Option, Stream } from "effect"
import { runKeyedDispatch } from "../../runtime-keyed-subscriber/index.ts"
import { RuntimeContextInputFacts } from "../../tables/runtime-context-input-facts.ts"
import { RuntimeAgentOutputAfterEvents } from "../../tables/runtime-context-output-facts.ts"
import {
  RuntimeContextRead,
  RuntimeContexts,
  RuntimeRunAppendAndGet,
} from "../../authorities/index.ts"
import {
  handleRuntimeContextEvent,
  type RuntimeContextTargetEvent,
} from "./handler.ts"
import { asRuntimeContextError } from "../../runtime-errors.ts"

// Note: `handleRuntimeContextEvent` + `RuntimeContextTargetEvent` are NOT
// re-exported from this barrel. Consumers (tests, host-sdk session
// adapters, sims) import them directly from `./handler.ts`. The barrel's
// public surface is just `RuntimeContextSubscriberLive` — the Layer that
// host composition wires in.

/**
 * Per-event handler bound to the keyed dispatcher. Resolves `(context,
 * activityAttempt)` from typed authority services, then delegates to
 * `handleRuntimeContextEvent`. Events that arrive before the context
 * row or its first `runs.started` row materialize are dropped silently
 * (the durable state advances on the next replay of the input row via
 * `insertOrGet`-idempotent semantics; the keyed source replays from the
 * intent log on every subscriber materialization).
 */
const handle = (contextId: string, event: RuntimeContextTargetEvent) =>
  Effect.gen(function* () {
    const contextRead = yield* RuntimeContextRead
    const runs = yield* RuntimeRunAppendAndGet
    const contextOpt = yield* contextRead.readContext(contextId).pipe(
      Effect.mapError((cause) =>
        asRuntimeContextError(
          "runtime-context.subscriber.context_lookup",
          "failed to read context row from durable substrate",
          contextId,
          cause,
        )),
    )
    if (Option.isNone(contextOpt)) return
    const context = contextOpt.value
    const attemptOpt = yield* runs.latestStartedAttempt(contextId).pipe(
      Effect.mapError((cause) =>
        asRuntimeContextError(
          "runtime-context.subscriber.attempt_lookup",
          "failed to read latest runs.started row",
          contextId,
          cause,
        )),
    )
    if (Option.isNone(attemptOpt)) return
    yield* handleRuntimeContextEvent(context, attemptOpt.value, event)
  })

/**
 * Build the keyed source: merge of per-context input + output streams,
 * fanned out across discovered contexts.
 */
const buildSource = (
  contexts: Stream.Stream<{ readonly contextId: string }, unknown>,
  inputFacts: RuntimeContextInputFacts["Type"],
  outputFacts: RuntimeAgentOutputAfterEvents["Type"],
): Stream.Stream<
  { readonly key: string; readonly event: RuntimeContextTargetEvent },
  unknown
> =>
  contexts.pipe(
    Stream.flatMap(
      (context) => {
        const contextId = context.contextId
        const inputs = inputFacts.forContext(contextId).pipe(
          Stream.map(
            (row): { readonly key: string; readonly event: RuntimeContextTargetEvent } => ({
              key: contextId,
              event: { _tag: "Input", event: row },
            }),
          ),
        )
        const outputs = outputFacts.forContext(contextId).pipe(
          Stream.map(
            (obs): { readonly key: string; readonly event: RuntimeContextTargetEvent } => ({
              key: contextId,
              event: { _tag: "Output", event: obs },
            }),
          ),
        )
        return Stream.merge(inputs, outputs)
      },
      { concurrency: "unbounded" },
    ),
    Stream.withSpan("firegrid.runtime_context.subscriber.source", {
      kind: "internal",
    }),
  )

/**
 * `RuntimeContextSubscriberLive` — Shape (b) loop-body Layer.
 *
 * Acquisition forks the keyed dispatcher onto the Layer's scope.
 * Release interrupts it. The dispatcher requires the handler's `R`
 * (`RuntimeContextStateStore | RuntimeContextWorkflowSession |
 * RuntimeToolUseExecutor | RuntimeRunAppendAndGet`) which the Layer
 * takes as `RIn` — host-sdk provides them via the existing per-context
 * state store + session adapter + tool executor + control-plane
 * recorder bindings.
 */
export const RuntimeContextSubscriberLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const inputFacts = yield* RuntimeContextInputFacts
    const outputFacts = yield* RuntimeAgentOutputAfterEvents
    const contexts = yield* RuntimeContexts
    const source = buildSource(contexts, inputFacts, outputFacts)
    yield* Effect.forkScoped(
      runKeyedDispatch({ source, handle, concurrency: "unbounded" }).pipe(
        Effect.withSpan("firegrid.runtime_context.subscriber.dispatch", {
          kind: "internal",
        }),
      ),
    )
  }),
)
