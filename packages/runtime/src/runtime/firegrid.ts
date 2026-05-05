import {
  runScheduledWorkSubscriberFromSnapshot,
  runTimerSubscriberFromSnapshot,
  type CompletionKind,
  type EventStream,
  type Operation,
  type ProjectionSnapshot,
  type SubscriberError,
  type SubscriberInput,
} from "@firegrid/substrate/kernel"
import type { CurrentWorkContext } from "@firegrid/substrate"
import { Effect, Layer } from "effect"
import {
  minPendingDueAtMs,
  runScopedSubscriberProgram,
  subscribeCompletions,
} from "./internal/runner.ts"
import { runOperationHandler } from "./internal/operation-handler.ts"
import { runEventStreamMaterializer } from "./internal/event-stream-materializer.ts"
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
// firegrid-operation-messaging.RUNTIME_HANDLERS.2
// firegrid-operation-messaging.RUNTIME_HANDLERS.3
// firegrid-operation-messaging.RUNTIME_HANDLERS.4
//
// Firegrid.handler installs a typed runtime handler for the given
// Operation. The returned Layer dispatches matching started runs
// (envelope + operation name) to `run` with the message-scoped
// CurrentWorkContext already provided, encodes the success/failure
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
): Layer.Layer<never, never, Exclude<R, CurrentWorkContext> | RuntimeContext> =>
  Layer.scopedDiscard(runOperationHandler({ op, run }))

// firegrid-event-streams.RUNTIME_API.1
// firegrid-event-streams.RUNTIME_API.2
// firegrid-event-streams.RUNTIME_API.3
// firegrid-event-streams.SCHEMA_OWNERSHIP.2
// firegrid-event-streams.SCHEMA_OWNERSHIP.3
//
// Firegrid.eventStream installs a typed runtime materializer for the
// given EventStream descriptor. The returned Layer follows the
// runtime's substrate stream raw, filters for the Firegrid event
// envelope (E1 wire format, decided in coordination with the client
// slice), decodes the event via the descriptor's Schema, and runs
// the caller's materializer Effect once per event in order.
//
// Materialized state lives in caller code or downstream durable
// writes; the materializer never writes substrate authority rows.
// Long-running materializer fibers are Scope-bound — finalizing
// the providing Layer's scope interrupts the fiber and tears down
// the underlying DurableStream session.
const eventStream = <S extends EventStream.Any, E = never, R = never>(
  descriptor: S,
  materialize: (
    event: EventStream.Event<S>,
  ) => Effect.Effect<void, E, R>,
): Layer.Layer<never, never, R | RuntimeContext> =>
  Layer.scopedDiscard(
    runEventStreamMaterializer({ descriptor, materialize }),
  )

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
  eventStream,
} as const
