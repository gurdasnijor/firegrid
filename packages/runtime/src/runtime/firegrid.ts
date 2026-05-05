import {
  runScheduledWorkSubscriber,
  runTimerSubscriber,
  type CompletionKind,
  type SubscriberError,
  type SubscriberInput,
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
// `Firegrid` is the runtime helper namespace.
//
// CAVEAT: `Firegrid.subscribers.{timer, scheduledWork}` is
// transitional low-level runtime infrastructure exposed only so
// dev runtime processes can wire substrate's stock timer and
// scheduled-work subscribers without re-implementing the wake/
// coalesce loop. It is NOT the desired app/runtime API. Once
// Operation.handler and EventStream materializers land, those
// descriptor-driven Layers are the canonical app surface; the bare
// `subscribers.*` helpers stay only as low-level building blocks
// (or are dropped if they have no remaining caller).

interface DueTimeProfile<K extends CompletionKind> {
  readonly kind: K
  readonly deadlineField: string
  readonly scan: (
    input: SubscriberInput,
  ) => Effect.Effect<unknown, SubscriberError>
}

const dueTimeSubscriberLayer = <K extends CompletionKind>(
  profile: DueTimeProfile<K>,
): Layer.Layer<never, never, RuntimeContext> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const cfg = yield* RuntimeContext
      yield* runScopedSubscriberProgram({
        subscribe: subscribeCompletions,
        nextDeadlineMs: (snapshot) =>
          minPendingDueAtMs(snapshot.completions, (completion) => {
            if (completion.kind !== profile.kind) return undefined
            const data = completion.data as
              | Record<string, unknown>
              | undefined
            const value = data?.[profile.deadlineField]
            return typeof value === "number" ? value : undefined
          }),
        scan: profile.scan({
          streamUrl: cfg.streamUrl,
          contentType: cfg.contentType,
        }),
      })
    }),
  )

export const Firegrid = {
  subscribers: {
    timer: dueTimeSubscriberLayer({
      kind: "timer",
      deadlineField: "dueAtMs",
      scan: runTimerSubscriber,
    }),
    scheduledWork: dueTimeSubscriberLayer({
      kind: "scheduled_work",
      deadlineField: "whenMs",
      scan: runScheduledWorkSubscriber,
    }),
  },
} as const
