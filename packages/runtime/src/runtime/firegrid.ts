import {
  runScheduledWorkSubscriber,
  runTimerSubscriber,
} from "@durable-agent-substrate/substrate"
import { Effect, Layer } from "effect"
import {
  minPendingDueAtMs,
  runScopedSubscriberProgram,
  subscribeCompletions,
} from "./internal/runner.ts"
import { RuntimeContext } from "./runtime-context.ts"

// firegrid-architecture-boundary.SURFACE_AREA.2
// firegrid-package-migration.RUNTIME_RENAME.5
// firegrid-runtime-process.RUNTIME_PACKAGE.2
//
// `Firegrid` is the runtime helper namespace. The current public
// surface is intentionally tiny: just `subscribers.timer` and
// `subscribers.scheduledWork`, which wrap substrate's single-shot
// subscriber Effects in subscription/deadline-driven runner Layers.
//
// Operation messaging (Firegrid.handler), EventStream materializers,
// and projection-match / claim-before-side-effect operator helpers
// land with subsequent slices and replace the old graph-vocabulary
// helpers entirely. The runner skeleton lives in
// `runtime/internal/runner.ts` (private) so the public namespace
// stays one screen of code.

const timerSubscriberLayer: Layer.Layer<never, never, RuntimeContext> =
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const cfg = yield* RuntimeContext
      yield* runScopedSubscriberProgram({
        subscribe: subscribeCompletions,
        nextDeadlineMs: (snapshot) =>
          minPendingDueAtMs(snapshot.completions, (c) => {
            if (c.kind !== "timer") return undefined
            const data = c.data as { readonly dueAtMs?: unknown } | undefined
            return data !== undefined && typeof data.dueAtMs === "number"
              ? data.dueAtMs
              : undefined
          }),
        scan: runTimerSubscriber({
          streamUrl: cfg.streamUrl,
          contentType: cfg.contentType,
        }),
      })
    }),
  )

const scheduledWorkSubscriberLayer: Layer.Layer<
  never,
  never,
  RuntimeContext
> = Layer.scopedDiscard(
  Effect.gen(function* () {
    const cfg = yield* RuntimeContext
    yield* runScopedSubscriberProgram({
      subscribe: subscribeCompletions,
      nextDeadlineMs: (snapshot) =>
        minPendingDueAtMs(snapshot.completions, (c) => {
          if (c.kind !== "scheduled_work") return undefined
          const data = c.data as { readonly whenMs?: unknown } | undefined
          return data !== undefined && typeof data.whenMs === "number"
            ? data.whenMs
            : undefined
        }),
      scan: runScheduledWorkSubscriber({
        streamUrl: cfg.streamUrl,
        contentType: cfg.contentType,
      }),
    })
  }),
)

export const Firegrid = {
  subscribers: {
    timer: timerSubscriberLayer,
    scheduledWork: scheduledWorkSubscriberLayer,
  },
} as const
