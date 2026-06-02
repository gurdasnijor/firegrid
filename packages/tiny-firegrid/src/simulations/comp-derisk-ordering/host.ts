import {
  defaultProductionAdapterLayer,
  FiregridRuntime,
  RuntimeOutputTable,
} from "@firegrid/runtime/unified"
import { Effect, Layer, Stream } from "effect"
import type {
  FiregridHost,
  TinyFiregridHostEnv,
} from "../../types.ts"

// tf-0awo.20 — §3.1 / §12 Seam 1b output-ordering de-risk.
//
// Host-scoped, harness-private instrumentation (methodology: observers for
// conditions not visible on the public client surface, composed from ordinary
// Stream ops, local to the sim). It subscribes to the HOST-WIDE
// `RuntimeOutputTable.events` projection — the exact append-ordered read the
// §12 cutover relies on to deliver order intrinsically once the client-sdk
// `compareJournalRows` (activityAttempt, sequence) sort is deleted — and emits
// one span per row in arrival/append order carrying (appendIndex,
// activityAttempt, sequence, contextId).
//
// The trace is the deliverable: whether `rows()` append order equals
// (activityAttempt, sequence) order, and whether any sequence is dropped or
// duplicated, is READ OFF these spans. This layer computes no verdict.
const outputOrderProbe = Layer.scopedDiscard(
  Effect.gen(function*() {
    const output = yield* RuntimeOutputTable
    yield* output.events.rows().pipe(
      Stream.zipWithIndex,
      Stream.runForEach(([row, appendIndex]) =>
        Effect.void.pipe(
          Effect.withSpan("firegrid.sim.output_order_probe", {
            kind: "internal",
            attributes: {
              "firegrid.sim.append_index": appendIndex,
              "firegrid.sim.activity_attempt": row.activityAttempt,
              "firegrid.sim.sequence": row.sequence,
              "firegrid.context.id": row.contextId,
            },
          }),
        ),
      ),
      // The projection is an infinite live stream; run it as a background
      // daemon tied to the host scope. Swallow teardown interruption so it
      // never turns the host build red.
      Effect.catchAllCause(() => Effect.void),
      Effect.forkScoped,
    )
  }),
)

export const host = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown> =>
  outputOrderProbe.pipe(
    Layer.provideMerge(
      FiregridRuntime(
        {
          durableStreamsBaseUrl: env.durableStreamsBaseUrl,
          namespace: env.namespace,
        },
        defaultProductionAdapterLayer(),
      ),
    ),
  )
