import {
  runTimerSubscriber,
  type SubscriberError,
} from "@durable-agent-substrate/substrate"
import { Effect } from "effect"
import type { SubscriberLivenessHandle } from "./liveness.js"
import { runSubscriberProgram } from "./runner.js"

// Thin wiring: the host runner is generic; this module binds the
// "timer" subscriber kind to the existing single-shot
// `runTimerSubscriber` Effect. Substrate is left untouched per
// option (ii) in the v2 pre-implementation packet.

export const runTimerSubscriberProgram = (input: {
  readonly streamUrl: string
  readonly contentType: string
  readonly liveness: SubscriberLivenessHandle
}): Effect.Effect<void, never, never> => {
  const scan: Effect.Effect<unknown, SubscriberError> = runTimerSubscriber({
    streamUrl: input.streamUrl,
    contentType: input.contentType,
  })
  return runSubscriberProgram({
    kind: "timer",
    streamUrl: input.streamUrl,
    contentType: input.contentType,
    liveness: input.liveness,
    runScan: scan,
  })
}
