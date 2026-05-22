// sidecar/shape-c-input-facts: Shape C input-fact read-side source.
//
// Greenfield replacement for the per-sequence `DurableDeferred` input mailbox
// (`runtime-input-deferred.ts`) and the host-scoped `RuntimeInputIntentDispatcher`
// fiber. RuntimeContext input arrival is now a direct durable fact:
// `RuntimeControlPlaneTable.inputIntents` is the input log keyed by `intentId`
// (== domain input identity), idempotent on `insertOrGet`. The Shape C
// RuntimeContext handler (CC2, PR #679) subscribes to this typed source per
// `contextId` and receives `RuntimeIngressInputRow` events directly — no
// sequence allocation, no kernel-allocated ordinal authority, no cross-event
// mailbox.
//
// This PR (#682) is **stacked behind #679 (Shape C handler) and #680 (CC1
// subscriber-runtime helper)** in the Wave 1 integration. Public host flows
// (start context / spawn child / sync-run stdin delivery) currently route
// through the OLD `RuntimeContextWorkflowNative` body via the deleted-here
// mailbox. They will pass through the new path once #679 wires CC2's handler
// in. See the deletion classification in this PR body / `runtime-design-
// constraints.md` (C4 baseline ratcheted -2 by this slice).
//
// `runtime-pipeline-type-boundaries.md` Shape C contract:
//   transitionInputEvent(state, row: RuntimeIngressInputRow, event) -> result
//
// The intent row already carries every field the pure transition needs; this
// module is the thin adapter that exposes the intent log as a typed input-row
// stream per contextId. No kernel sequence is assigned; `sequence`/`sequencedAt`
// are intentionally absent (`status: "pending"` is the only steady-state value),
// because identity is `inputId`/`intentId`, not an allocated ordinal.

import {
  RuntimeControlPlaneTable,
} from "@firegrid/protocol/launch"
import {
  type RuntimeIngressInputRow,
  type RuntimeInputIntentRow,
} from "@firegrid/protocol/runtime-ingress"
import { Context, Effect, Layer, Stream } from "effect"

/**
 * Convert a durable `RuntimeInputIntentRow` into the `RuntimeIngressInputRow`
 * shape the Shape C handler's pure `transitionInputEvent` expects.
 *
 * The two rows are nearly identical; the kernel-assigned `sequence`,
 * `sequencedAt`, and post-sequencing `status` fields are intentionally dropped
 * because Shape C has no sequence allocator. Identity comes from
 * `inputId === intent.intentId`. The transition is unaffected: it correlates
 * by `inputId`, not by ordinal.
 */
export const ingressInputRowFromIntent = (
  intent: RuntimeInputIntentRow,
): RuntimeIngressInputRow => ({
  inputId: intent.intentId,
  status: "pending",
  contextId: intent.contextId,
  kind: intent.kind,
  authoredBy: intent.authoredBy,
  payload: intent.payload,
  ...(intent.idempotencyKey === undefined
    ? {}
    : { idempotencyKey: intent.idempotencyKey }),
  ...(intent.metadata === undefined ? {} : { metadata: intent.metadata }),
  createdAt: intent.createdAt,
  ...(intent._otel === undefined ? {} : { _otel: intent._otel }),
})

interface RuntimeContextInputFactsService {
  /**
   * Per-context durable input-fact stream. Tails the `inputIntents` table
   * filtered by `contextId`, decoded into the handler-facing
   * `RuntimeIngressInputRow` shape.
   *
   * Substrate behavior:
   * - `inputIntents.rows()` replays the durable history once (initial state)
   *   then emits each new fact as producers append, so a restarting Shape C
   *   subscriber reconstructs progress from the durable log without any
   *   in-memory dispatcher.
   * - `insertOrGet` makes producer writes idempotent on `intentId`, so a
   *   duplicate intent surfaces as one fact, not two.
   * - The CC1 helper (`tf-4fy3` per-key subscriber proof) is the runtime
   *   serialization wrapper around this source: fork-per-fact + per-key
   *   `Semaphore(1)` keyed by `contextId`. This source itself does not enforce
   *   ordering; it is the unsorted typed projection. The handler owns
   *   per-context serialization.
   */
  readonly forContext: (
    contextId: string,
  ) => Stream.Stream<RuntimeIngressInputRow, unknown>
}

export class RuntimeContextInputFacts extends Context.Tag(
  "@firegrid/runtime/RuntimeContextInputFacts",
)<RuntimeContextInputFacts, RuntimeContextInputFactsService>() {}

const makeRuntimeContextInputFacts = (
  control: RuntimeControlPlaneTable["Type"],
): RuntimeContextInputFactsService => ({
  forContext: (contextId) =>
    control.inputIntents.rows().pipe(
      Stream.filter((intent) => intent.contextId === contextId),
      Stream.map(ingressInputRowFromIntent),
      Stream.withSpan("firegrid.runtime_context.input_facts.for_context", {
        kind: "internal",
        attributes: {
          "firegrid.context.id": contextId,
        },
      }),
    ),
})

export const RuntimeContextInputFactsLive = Layer.effect(
  RuntimeContextInputFacts,
  Effect.map(RuntimeControlPlaneTable, makeRuntimeContextInputFacts),
)
