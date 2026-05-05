import {
  runScheduledWorkSubscriber,
  type SubscriberError,
} from "@durable-agent-substrate/substrate"
import { Effect } from "effect"
import type { SubscriberLivenessHandle } from "./liveness.js"
import { runSubscriberProgram } from "./runner.js"

// Thin wiring for the "scheduled_work" subscriber kind. See
// timer.ts for the equivalent timer wiring.

export const runScheduledWorkSubscriberProgram = (input: {
  readonly streamUrl: string
  readonly contentType: string
  readonly liveness: SubscriberLivenessHandle
}): Effect.Effect<void, never, never> => {
  const scan: Effect.Effect<unknown, SubscriberError> =
    runScheduledWorkSubscriber({
      streamUrl: input.streamUrl,
      contentType: input.contentType,
    })
  return runSubscriberProgram({
    kind: "scheduled_work",
    streamUrl: input.streamUrl,
    contentType: input.contentType,
    liveness: input.liveness,
    runScan: scan,
  })
}
