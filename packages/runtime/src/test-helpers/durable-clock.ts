/**
 * Shared test helper for driving `DurableClock` wake-ups.
 *
 * Production runtime hosts run a clock-firing loop that polls
 * `fireDueWorkflowClocks(now)` so durable clock wake-ups schedule
 * `DurableDeferred` resolution. Unit tests do not have that loop, but
 * any code path that touches `DurableClock.sleep` with
 * `inMemoryThreshold: Duration.zero` (which Firegrid's `sleep` arm
 * forces — see `runSleepTool` in `agent-tools/tool-use-to-effect.ts`)
 * parks on a durable deferred regardless of how small the duration is.
 *
 * To exercise those paths in `vitest`, the test program forks this
 * helper inside an `Effect.scoped` block so the clock-firing fiber
 * lives only for the test's lifetime. Call sites do:
 *
 * ```ts
 * Effect.gen(function* () {
 *   yield* driveClocks
 *   // ... rest of the test that calls toolkit handlers ...
 * })
 * ```
 *
 * This helper is NOT part of the production runtime; it is a test
 * stand-in for the runtime host's clock firer. It lives under
 * `packages/runtime/src/test-helpers/` so multiple test files can share
 * one definition.
 */

import { Effect } from "effect"
import { fireDueWorkflowClocks } from "../workflow-engine/DurableStreamsWorkflowEngine.ts"

/* eslint-disable local/no-fixed-polling -- this helper stands in for
   the runtime host's clock-firing loop inside unit tests only;
   production code does not poll here. */
export const driveClocks = Effect.gen(function* () {
  while (true) {
    yield* fireDueWorkflowClocks(Date.now() + 10_000).pipe(
      Effect.catchAll(() => Effect.void),
    )
    yield* Effect.sleep("25 millis")
  }
}).pipe(Effect.forkScoped)
/* eslint-enable local/no-fixed-polling */
