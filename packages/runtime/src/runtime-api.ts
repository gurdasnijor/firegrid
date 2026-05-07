import {
  decodeAtBoundary,
  deriveReadyWork,
  encodeAtBoundary,
  isOperationEnvelope,
  processReadyWorkItem,
  runProjectionMatchSubscriberFromSnapshot,
  runScheduledWorkSubscriberFromSnapshot,
  runTimerSubscriberFromSnapshot,
  snapshotFromDb,
  type ClaimOutcome,
  type CompletionKind,
  type EventStream,
  type Operation,
  type ProjectionSnapshot,
  type ProjectionMatchEvaluation,
  type ProjectionMatchEvaluator,
  type ReadyWorkItem,
  type RunValue,
  type SubscriberError,
  type SubscriberInput,
} from "@firegrid/substrate/kernel"
/* eslint-disable @effect/no-import-from-barrel-package -- choreography-facade.CURRENT_WORK_CONTEXT.1: CurrentWorkContext is intentionally exported from the curated substrate root. */
import {
  OwnerId,
  type ProjectionMatchTrigger,
  WorkId,
  currentWorkContextLayer,
  type CurrentWorkContext,
} from "@firegrid/substrate"
/* eslint-enable @effect/no-import-from-barrel-package */
import {
  Cause,
  Effect,
  Layer,
  Stream,
  type Context,
  type ParseResult,
  type Scope,
} from "effect"
import {
  type DurableChannelDefinition,
  type DurableTerminalRecord,
  type CompletionKey,
  type PlaneProjectionQuery,
} from "@firegrid/substrate/event-plane"
import type { StreamStateDefinition } from "@durable-streams/state"
import {
  acquireSubstrateDb,
} from "@firegrid/substrate/kernel"
import {
  minPendingDueAtMs,
  runScopedSubscriberProgram,
  subscribeCompletions,
  subscribeCompletionsAndEventStreams,
} from "./internal/runner.ts"
import {
  AcquireDbError,
  runOperationHandler,
} from "./internal/operation-handler.ts"
import { runEventStreamMaterializer } from "./internal/event-stream-materializer.ts"
import { wakeStream } from "./internal/wake-stream.ts"
import { RuntimeContext, type RuntimeContextService } from "./context.ts"
import { composeRuntime } from "./composition.ts"

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

const pendingDeadlineAt = (
  completion: { readonly kind: CompletionKind; readonly data?: unknown },
  kind: CompletionKind,
  deadlineField: string,
): number | undefined => {
  if (completion.kind !== kind) return undefined
  const data = completion.data as Record<string, unknown> | undefined
  const value = data?.[deadlineField]
  return typeof value === "number" ? value : undefined
}

const subscriberLayer = (input: {
  readonly subscribe: typeof subscribeCompletions
  readonly subscribeRawJsonRows?: boolean
  readonly nextDeadlineMs: (snapshot: ProjectionSnapshot) => number | undefined
  readonly scan: (
    snapshot: ProjectionSnapshot,
    input: SubscriberInput,
  ) => Effect.Effect<unknown, SubscriberError>
}): Layer.Layer<never, never, RuntimeContext> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const cfg = yield* RuntimeContext
      const subscriberInput: SubscriberInput = {
        streamUrl: cfg.streamUrl,
        contentType: cfg.contentType,
      }
      yield* runScopedSubscriberProgram({
        subscribe: input.subscribe,
        ...(input.subscribeRawJsonRows === true
          ? { subscribeRawJsonRows: true }
          : {}),
        nextDeadlineMs: input.nextDeadlineMs,
        scan: (snapshot) => input.scan(snapshot, subscriberInput),
      })
    }),
  )

const deadlineSubscriberLayer = <K extends CompletionKind>(
  profile: DeadlineSubscriberProfile<K>,
): Layer.Layer<never, never, RuntimeContext> =>
  subscriberLayer({
    subscribe: subscribeCompletions,
    nextDeadlineMs: (snapshot) =>
      minPendingDueAtMs(snapshot.completions, (completion) =>
        pendingDeadlineAt(
          completion,
          profile.kind,
          profile.deadlineField,
        ),
      ),
    scan: (snapshot, subscriberInput) =>
      profile.scan(snapshot, subscriberInput),
  })

interface ProjectionMatchSubscriberOptions {
  readonly evaluate: ProjectionMatchEvaluator
}

interface DurableChannelCompletionSubscriberOptions {
  readonly matcherId: string
  readonly completionKeyFromTrigger?: (
    trigger: ProjectionMatchTrigger,
  ) => CompletionKey
  readonly matchedValue?: (terminal: DurableTerminalRecord) => unknown
}

const durableChannelRuntimeCompletionQuery = <
  Name extends string,
  S extends StreamStateDefinition,
  DeliveryInput,
>(
  channel: DurableChannelDefinition<Name, S, DeliveryInput>,
  completionKey: CompletionKey,
): PlaneProjectionQuery<S, DurableTerminalRecord | undefined> => ({
  label: `runtime-durable-channel:${channel.name}:completion:${completionKey}`,
  authority: "terminal-domain",
  evaluate: (snapshot) =>
    Effect.succeed(
      [
        ...channel.select.completions(snapshot),
        ...(channel.select.terminalFailures?.(snapshot) ?? []),
        ...channel.select.deadLetters(snapshot),
      ].find((terminal) => terminal.completionKey === completionKey),
    ),
})

// firegrid-runtime-process.RUNTIME_PACKAGE.5
// firegrid-runtime-process.RUNTIME_HOT_PATH.2
// firegrid-runtime-process.RUNTIME_HOT_PATH.3
//
// Low-level runtime wiring for substrate's projection-match subscriber.
// The evaluator stays explicit rather than using TriggerMatchers because the
// substrate scan receives the full ProjectionSnapshot; TriggerMatchers lookups
// are trigger-only and are consumed by RunWait when creating waits.
const projectionMatchSubscriberLayer = (
  options: ProjectionMatchSubscriberOptions,
): Layer.Layer<never, never, RuntimeContext> =>
  subscriberLayer({
    subscribe: subscribeCompletionsAndEventStreams,
    subscribeRawJsonRows: true,
    nextDeadlineMs: (snapshot) =>
      minPendingDueAtMs(snapshot.completions, (completion) =>
        pendingDeadlineAt(
          completion,
          "projection_match",
          "deadlineAtMs",
        ),
      ),
    scan: (snapshot, subscriberInput) =>
      runProjectionMatchSubscriberFromSnapshot(snapshot, {
        ...subscriberInput,
        evaluate: options.evaluate,
      }),
  })

// firegrid-durable-subscriber-webhooks.WAIT_INTEGRATION.1
// firegrid-durable-subscriber-webhooks.WAIT_INTEGRATION.2
// firegrid-durable-subscriber-webhooks.WAIT_INTEGRATION.3
//
// Runtime recipe that resolves projection-match waits from caller-owned
// durable-channel terminal rows. It composes the existing projection-match
// subscriber with the channel's EventPlane Projection; it does not introduce a
// new wait row shape, transport adapter, or product vocabulary.
const durableChannelCompletionSubscriberLayer = <
  Name extends string,
  S extends StreamStateDefinition,
  DeliveryInput,
>(
  channel: DurableChannelDefinition<Name, S, DeliveryInput>,
  options: DurableChannelCompletionSubscriberOptions,
): Layer.Layer<
  never,
  never,
  RuntimeContext | Context.Tag.Identifier<typeof channel.plane.Projection>
> =>
  Layer.unwrapEffect(
    Effect.gen(function* () {
      const projection = yield* channel.plane.Projection
      return projectionMatchSubscriberLayer({
        evaluate: (_snapshot, trigger) => {
          if (trigger.matcherId !== options.matcherId) {
            return Effect.succeed<ProjectionMatchEvaluation>({
              kind: "no-match",
            })
          }
          const completionKey = options.completionKeyFromTrigger?.(trigger)
            ?? (trigger.projectionKey as CompletionKey)
          return projection
            .snapshot(durableChannelRuntimeCompletionQuery(channel, completionKey))
            .pipe(
              Effect.map((terminal): ProjectionMatchEvaluation => {
                if (terminal === undefined) return { kind: "no-match" }
                return {
                  kind: "match",
                  value: options.matchedValue?.(terminal) ?? terminal.value,
                }
              }),
            )
        },
      })
    }),
  )

// firegrid-runtime-process.READY_WORK_OPERATOR.1
// firegrid-runtime-process.READY_WORK_OPERATOR.2
// firegrid-runtime-process.READY_WORK_OPERATOR.3
// firegrid-runtime-process.READY_WORK_OPERATOR.4
// firegrid-runtime-process.READY_WORK_OPERATOR.5
// firegrid-runtime-process.READY_WORK_OPERATOR.6
// claim-and-operator-authority.OPERATOR_INVOCATION.16
// claim-and-operator-authority.OPERATOR_INVOCATION.17
// ready-work-projection.READY_WORK_PROJECTION.11
//
// Ready-work operator loop helpers — inlined here (rather than a
// separate exported module) so the runtime continues to publish a
// single Effect-returning seam through `Firegrid.handler` instead of a
// new top-level effect-returning export.
const decodeBlockedEnvelope = <Op extends Operation.Any>(
  op: Op,
  run: RunValue,
): Effect.Effect<Operation.Input<Op> | undefined, ParseResult.ParseError> => {
  if (run.state !== "blocked") return Effect.succeed(undefined)
  if (!isOperationEnvelope(run.data)) return Effect.succeed(undefined)
  if (run.data.operation !== op.name) return Effect.succeed(undefined)
  return decodeAtBoundary(op.input, (cause) => cause)(run.data.payload).pipe(
    Effect.map((value) => value as Operation.Input<Op>),
  )
}

// firegrid-runtime-process.READY_WORK_OPERATOR.6
const logReadyWorkOutcome = <A, E>(
  opName: string,
  outcome: ClaimOutcome<A, E>,
): Effect.Effect<void> => {
  if (outcome.kind === "completed" || outcome.kind === "failed") {
    return Effect.void
  }
  if (outcome.kind === "claim-lost") {
    return Effect.logDebug(
      `firegrid ready-work ${opName}: claim lost for run ${outcome.runId} (winner ${outcome.winner.ownerId}/${outcome.winner.claimId})`,
    )
  }
  if (outcome.kind === "already-terminal") {
    return Effect.logDebug(
      `firegrid ready-work ${opName}: run ${outcome.runId} already ${outcome.runState}`,
    )
  }
  return Effect.logDebug(
    `firegrid ready-work ${opName}: terminalization lost for run ${outcome.runId} (observed ${outcome.terminalState})`,
  )
}

const buildReadyWorkHandler = <Op extends Operation.Any, E, R>(
  cfg: RuntimeContextService,
  op: Op,
  decodedInput: Operation.Input<Op>,
  runValue: RunValue,
  run: (
    input: Operation.Input<Op>,
  ) => Effect.Effect<Operation.Output<Op>, Operation.Error<Op> | E, R>,
): ((
  item: ReadyWorkItem,
) => Effect.Effect<unknown, unknown, Exclude<R, CurrentWorkContext>>) =>
  (_item) =>
    run(decodedInput).pipe(
      Effect.provide(
        currentWorkContextLayer({
          workId: WorkId(runValue.runId),
          ownerId: OwnerId(cfg.processId),
        }),
      ),
      Effect.flatMap((output) =>
        encodeAtBoundary(op.output, (cause) => cause)(output).pipe(
          Effect.catchTag("ParseError", (cause) =>
            Effect.logError(
              `firegrid ready-work ${op.name}: output encode failed for run ${runValue.runId}`,
              cause,
            ).pipe(
              Effect.flatMap(() =>
                Effect.fail(
                  `output-encode-failed: ${Cause.pretty(Cause.fail(cause))}`,
                ),
              ),
            ),
          ),
        ),
      ),
      Effect.catchAll((error) =>
        encodeAtBoundary(
          op.error,
          (cause) => cause,
        )(error as Operation.Error<Op>).pipe(
          Effect.catchTag("ParseError", () =>
            Effect.succeed(`handler-error: ${String(error)}`),
          ),
          Effect.flatMap((encoded) => Effect.fail<unknown>(encoded)),
        ),
      ),
    ) as Effect.Effect<unknown, unknown, Exclude<R, CurrentWorkContext>>

type ReadyWorkHandler<Op extends Operation.Any, E, R> = (
  input: Operation.Input<Op>,
) => Effect.Effect<Operation.Output<Op>, Operation.Error<Op> | E, R>

const runReadyWorkOperator = <Op extends Operation.Any, E, R>(
  op: Op,
  handlerRun: ReadyWorkHandler<Op, E, R>,
) =>
  Effect.gen(function* () {
    const cfg = yield* RuntimeContext
    const acquire = acquireSubstrateDb(
      { url: cfg.streamUrl, contentType: cfg.contentType },
      (cause) => new AcquireDbError({ cause }),
    )
    yield* Effect.forkScoped(
      Effect.scoped(
        Effect.gen(function* () {
          const db = yield* acquire

          const wakes = wakeStream((wake) =>
            Effect.sync(() => {
              const runsSub = db.collections.runs.subscribeChanges(wake)
              const completionsSub = db.collections.completions.subscribeChanges(
                wake,
              )
              wake()
              return Effect.sync(() => {
                runsSub.unsubscribe()
                completionsSub.unsubscribe()
              })
            }),
          )

          const matchableItems = (snapshot: ProjectionSnapshot) => {
            const projection = deriveReadyWork(snapshot)
            const items: Array<{
              readonly item: ReadyWorkItem
              readonly runValue: RunValue
            }> = []
            projection.readyWork.forEach((item) => {
              const runValue = snapshot.runs.get(item.runId)
              if (runValue === undefined) return
              if (!isOperationEnvelope(runValue.data)) return
              if (runValue.data.operation !== op.name) return
              items.push({ item, runValue })
            })
            return items
          }

          const dispatchItem = (item: ReadyWorkItem, runValue: RunValue) =>
            Effect.gen(function* () {
              const decoded = yield* decodeBlockedEnvelope(
                op,
                runValue,
              ).pipe(
                Effect.catchTag("ParseError", (cause) =>
                  Effect.logError(
                    `firegrid ready-work ${op.name}: input decode failed for run ${runValue.runId}`,
                    cause,
                  ).pipe(Effect.as(undefined)),
                ),
              )
              if (decoded === undefined) return
              const outcome = yield* processReadyWorkItem({
                streamUrl: cfg.streamUrl,
                ...(cfg.contentType !== undefined
                  ? { contentType: cfg.contentType }
                  : {}),
                ownerId: cfg.processId,
                item,
                handler: buildReadyWorkHandler(
                  cfg,
                  op,
                  decoded,
                  runValue,
                  handlerRun,
                ),
              }).pipe(
                Effect.catchAll((cause) =>
                  Effect.logError(
                    `firegrid ready-work ${op.name}: processReadyWorkItem failed for run ${runValue.runId}`,
                    cause,
                  ).pipe(
                    Effect.as<ClaimOutcome<unknown, unknown> | undefined>(
                      undefined,
                    ),
                  ),
                ),
              )
              if (outcome === undefined) return
              yield* logReadyWorkOutcome(op.name, outcome)
            })

          return yield* wakes.pipe(
            Stream.mapEffect(() =>
              Effect.forEach(
                matchableItems(snapshotFromDb(db)),
                ({ item, runValue }) => dispatchItem(item, runValue),
                { discard: true },
              ),
            ),
            Stream.runDrain,
            Effect.tapErrorCause((cause) =>
              Cause.isInterruptedOnly(cause)
                ? Effect.void
                : Effect.logError(
                    `firegrid ready-work ${op.name}: operator loop failed`,
                    cause,
                  ),
            ),
          )
        }),
      ),
    )
  })

// firegrid-operation-messaging.RUNTIME_HANDLERS.1
// firegrid-operation-messaging.RUNTIME_HANDLERS.2
// firegrid-operation-messaging.RUNTIME_HANDLERS.3
// firegrid-operation-messaging.RUNTIME_HANDLERS.4
// firegrid-runtime-process.READY_WORK_OPERATOR.7
//
// Firegrid.handler installs a typed runtime handler for the given
// Operation. The returned Layer installs two scoped fibers under one
// scope:
//
//   - the started-run dispatch loop (operation-handler) advances
//     freshly-declared runs whose envelope matches `op.name`.
//   - the ready-work operator loop resumes blocked runs whose pending
//     completion has resolved, claiming ownership through the
//     substrate authority before re-invoking the same handler.
//
// On resume, RunWait primitives (`sleep`, `awakeable`, `for`) are idempotent:
// their durable
// completion lookups short-circuit when the keyed completion already
// resolved, so the handler body progresses past its previous
// suspension point.
const handler = <
  Op extends Operation.Any,
  E = never,
  R = never,
>(
  op: Op,
  run: (
    input: Operation.Input<Op>,
  ) => Effect.Effect<Operation.Output<Op>, Operation.Error<Op> | E, R>,
): Layer.Layer<
  never,
  never,
  Exclude<Exclude<R, CurrentWorkContext>, Scope.Scope> | RuntimeContext
> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      yield* runOperationHandler({ op, run })
      yield* runReadyWorkOperator(op, run)
    }),
  )

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
    projectionMatch: projectionMatchSubscriberLayer,
    durableChannelCompletion: durableChannelCompletionSubscriberLayer,
  },
  handler,
  eventStream,
  composeRuntime,
} as const
