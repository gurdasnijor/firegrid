import { Firegrid } from "@firegrid/client-sdk/firegrid"
import { Effect } from "effect"

/**
 * tf-ui4l/INV-6 sub-sims: workflow execution lives in the host layer.
 * Driver yields Firegrid for type compatibility and blocks; host signals
 * stopSignal on workflow completion. See tf-ui4l-baseline/driver.ts for
 * the full rationale (OLA-2026-05-20 Q1 fallback notes).
 */
export const tfUi4lAlphaDriver: Effect.Effect<void, never, Firegrid> =
  Effect.gen(function*() {
    yield* Firegrid
    yield* Effect.never
  })
