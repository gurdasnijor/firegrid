import { Firegrid } from "@firegrid/client-sdk/firegrid"
import { Effect } from "effect"

/**
 * tf-ui4l/INV-6 sub-sims: workflow execution lives in the host layer.
 * See tf-ui4l-baseline/driver.ts for the full rationale.
 */
export const tfUi4lBetaDriver: Effect.Effect<void, never, Firegrid> =
  Effect.gen(function*() {
    yield* Firegrid
    yield* Effect.never
  })
