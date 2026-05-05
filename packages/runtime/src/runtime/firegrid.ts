import {
  runScheduledWorkSubscriberFromSnapshot,
  runTimerSubscriberFromSnapshot,
  type CompletionKind,
  type Operation,
  type ProjectionSnapshot,
  type SubscriberError,
  type SubscriberInput,
} from "@durable-agent-substrate/substrate"
import { Effect, Layer } from "effect"
import {
  minPendingDueAtMs,
  runScopedSubscriberProgram,
  subscribeCompletions,
} from "./internal/runner.ts"
import { runOperationHandler } from "./internal/operation-handler.ts"
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

// firegrid-runtime-process.RUNTIME_HOT_PATH.1
interface DeadlineSubscriberProfile<K extends CompletionKind> {
  readonly kind: K
  readonly deadlineField: string
  readonly scan: (
    snapshot: ProjectionSnapshot,
    input: SubscriberInput,
  ) => Effect.Effect<unknown, SubscriberError>
}

const deadlineSubscriberLayer = <K extends CompletionKind>(
  profile: DeadlineSubscriberProfile<K>,
): Layer.Layer<never, never, RuntimeContext> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const cfg = yield* RuntimeContext
      const subscriberInput: SubscriberInput = {
        streamUrl: cfg.streamUrl,
        contentType: cfg.contentType,
      }
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
        scan: (snapshot) => profile.scan(snapshot, subscriberInput),
      })
    }),
  )

// firegrid-operation-messaging.RUNTIME_HANDLERS.1
// firegrid-operation-messaging.RUNTIME_HANDLERS.4
//
// Firegrid.handler installs a typed runtime handler for the given
// Operation. The returned Layer dispatches matching started runs
// (envelope + operation name) to `run`, encodes the success/failure
// outcome via the descriptor's schemas, and durably appends a
// completeRun / failRun event so client `result(handle)` resolves.
const handler = <
  Op extends Operation.Any,
  E = never,
  R = never,
>(
  op: Op,
  run: (
    input: Operation.Input<Op>,
  ) => Effect.Effect<Operation.Output<Op>, Operation.Error<Op> | E, R>,
): Layer.Layer<never, never, R | RuntimeContext> =>
  Layer.scopedDiscard(runOperationHandler({ op, run }))

export const Firegrid = {
  subscribers: {
    timer: deadlineSubscriberLayer({
      kind: "timer",
      deadlineField: "dueAtMs",
      scan: runTimerSubscriberFromSnapshot,
    }),
    scheduledWork: deadlineSubscriberLayer({
      kind: "scheduled_work",
      deadlineField: "whenMs",
      scan: runScheduledWorkSubscriberFromSnapshot,
    }),
  },
  handler,
} as const
