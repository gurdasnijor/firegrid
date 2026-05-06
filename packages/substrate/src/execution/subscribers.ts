import { DurableStream } from "@durable-streams/client"
import type { StateEvent } from "@durable-streams/state"
import { Clock, Data, Effect, Option, type ParseResult } from "effect"
import { appendChange } from "../descriptors/append.ts"
import type { ProjectionSnapshot } from "../projection.ts"
import type { ProjectionMatchTrigger } from "../choreography/triggers.ts"
import {
  decodeCompletionData,
  decodeProjectionMatchCompletionData,
  ScheduledWorkCompletionData,
  TimerCompletionData,
  type CompletionKind,
  type CompletionValue,
} from "../schema/rows.ts"
import {
  cancelCompletion,
  type IllegalCompletionTransition,
  resolveCompletion,
} from "../schema/state-machine.ts"
import { rebuildProjection } from "../stream.ts"

// durable-subscribers.SUBSCRIBER_SCOPE.5 — single-shot scan-and-resolve.
// All three profiles share a stream-bound shape and return the list of
// completion ids they terminalized in this scan.

export class SubscriberStreamError extends Data.TaggedError("SubscriberStreamError")<{
  readonly cause: unknown
}> {}

// Malformed or missing required fields on the completion data payload.
export class SubscriberDataError extends Data.TaggedError("SubscriberDataError")<{
  readonly completionId: string
  readonly reason: string
}> {}

// Per-call evaluator (projection_match only) failed in its Effect channel.
export class SubscriberEvaluatorError extends Data.TaggedError(
  "SubscriberEvaluatorError",
)<{
  readonly completionId: string
  readonly cause: unknown
}> {}

export type SubscriberError =
  | SubscriberStreamError
  | SubscriberDataError
  | SubscriberEvaluatorError

export interface SubscriberInput {
  readonly streamUrl: string
  readonly contentType?: string
}

export interface TimerSubscriberResult {
  readonly resolvedIds: ReadonlyArray<string>
}

export interface ScheduledWorkSubscriberResult {
  readonly resolvedIds: ReadonlyArray<string>
}

export interface ProjectionMatchSubscriberResult {
  readonly resolvedIds: ReadonlyArray<string>
  readonly cancelledIds: ReadonlyArray<string>
}

// durable-subscribers.PROJECTION_MATCH_SUBSCRIBER.7 — per-call evaluator (no registry).
export type ProjectionMatchEvaluation =
  | { readonly kind: "match"; readonly value: unknown }
  | { readonly kind: "no-match" }

export type ProjectionMatchEvaluator = (
  snapshot: ProjectionSnapshot,
  trigger: ProjectionMatchTrigger,
  completion: CompletionValue,
) => Effect.Effect<ProjectionMatchEvaluation, unknown>

export interface ProjectionMatchSubscriberInput extends SubscriberInput {
  readonly evaluate: ProjectionMatchEvaluator
}

// CompletionValue is one struct with union-typed `kind`/`state` fields, so
// `Extract<CompletionValue, {kind: "timer"}>` collapses to never. Use a
// type-predicate-narrowed intersection instead.
type PendingOf<K extends CompletionKind> = CompletionValue & {
  readonly kind: K
  readonly state: "pending"
}

const isPendingOf =
  <K extends CompletionKind>(kind: K) =>
  (completion: CompletionValue): completion is PendingOf<K> =>
    completion.kind === kind && completion.state === "pending"

const openStream = (input: SubscriberInput) =>
  new DurableStream({
    url: input.streamUrl,
    contentType: input.contentType ?? "application/json",
  })

const loadSnapshot = (input: SubscriberInput) =>
  Effect.tryPromise({
    try: () =>
      rebuildProjection({
        url: input.streamUrl,
        contentType: input.contentType ?? "application/json",
      }),
    catch: (cause) => new SubscriberStreamError({ cause }),
  })

// Public single-shot wrappers reuse this to avoid repeating the
// `loadSnapshot(input).pipe(Effect.flatMap(...))` shape.
const withLoadedSnapshot = <A>(
  input: SubscriberInput,
  scan: (
    snapshot: ProjectionSnapshot,
  ) => Effect.Effect<A, SubscriberError>,
): Effect.Effect<A, SubscriberError> =>
  loadSnapshot(input).pipe(Effect.flatMap(scan))

const collectPending = <K extends CompletionKind>(
  snapshot: ProjectionSnapshot,
  kind: K,
): ReadonlyArray<PendingOf<K>> =>
  Array.from(snapshot.completions.values()).filter(isPendingOf(kind))

const appendEvent = (stream: DurableStream, event: StateEvent) =>
  appendChange(stream, event, (cause) => new SubscriberStreamError({ cause }))

// Defensive wrap: the declarative state-machine builders return
// IllegalCompletionTransition through the Effect error channel. In a
// subscriber loop that failure is a race signal (another writer terminalized
// between our snapshot read and our append attempt), so the caller skips this
// completion silently. Authority remains the first-valid-terminal fold.
const buildOrSkip = <A>(
  effect: Effect.Effect<A, IllegalCompletionTransition>,
): Effect.Effect<Option.Option<A>> =>
  effect.pipe(
    Effect.map(Option.some),
    Effect.catchTag("IllegalCompletionTransition", () =>
      Effect.succeed(Option.none()),
    ),
  )

const completionDataError = (completion: CompletionValue, field: string) =>
  (cause: ParseResult.ParseError) =>
    new SubscriberDataError({
      completionId: completion.completionId,
      reason: `invalid ${field} completion data: ${cause.message}`,
    })

// Shared scan skeleton for due-time-driven subscribers (timer / scheduled_work).
// The per-profile `decide` function inspects the completion at the current
// clock reading and returns one of three decisions; the skeleton handles the
// snapshot, filtering, sequential forEach, race-safe build, and append.
type DueTimeDecision =
  | { readonly kind: "skip" }
  | { readonly kind: "resolve"; readonly result: unknown }

interface DueTimeProfile<K extends "timer" | "scheduled_work"> {
  readonly kind: K
  readonly decide: (
    completion: PendingOf<K>,
    nowMs: number,
  ) => Effect.Effect<DueTimeDecision, SubscriberDataError>
}

const runDueTimeSubscriberFromSnapshot = <
  K extends "timer" | "scheduled_work",
>(
  snapshot: ProjectionSnapshot,
  input: SubscriberInput,
  profile: DueTimeProfile<K>,
): Effect.Effect<ReadonlyArray<string>, SubscriberError> =>
  scanPendingCompletions(snapshot, input, profile.kind, (ctx, completion) =>
    processDueTimeCandidate(
      ctx.stream,
      completion,
      ctx.nowMs,
      profile.decide,
    ),
  )

const scanPendingCompletions = <K extends CompletionKind, A>(
  snapshot: ProjectionSnapshot,
  input: SubscriberInput,
  kind: K,
  process: (
    ctx: { readonly stream: DurableStream; readonly nowMs: number },
    completion: PendingOf<K>,
  ) => Effect.Effect<Option.Option<A>, SubscriberError>,
): Effect.Effect<ReadonlyArray<A>, SubscriberError> =>
  Effect.gen(function* () {
    const stream = openStream(input)
    const nowMs = yield* Clock.currentTimeMillis
    const outcomes = yield* Effect.forEach(
      collectPending(snapshot, kind),
      (completion) => process({ stream, nowMs }, completion),
    )
    return outcomes.flatMap(Option.toArray)
  })

const processDueTimeCandidate = <K extends "timer" | "scheduled_work">(
  stream: DurableStream,
  completion: PendingOf<K>,
  nowMs: number,
  decide: (
    completion: PendingOf<K>,
    nowMs: number,
  ) => Effect.Effect<DueTimeDecision, SubscriberDataError>,
): Effect.Effect<Option.Option<string>, SubscriberError> =>
  Effect.gen(function* () {
    const decision = yield* decide(completion, nowMs)
    if (decision.kind === "skip") return Option.none()
    const eventOpt = yield* buildOrSkip(
      resolveCompletion(completion, { result: decision.result }),
    )
    if (Option.isNone(eventOpt)) return Option.none()
    yield* appendEvent(stream, eventOpt.value)
    return Option.some(completion.completionId)
  })

// durable-subscribers.TIMER_SUBSCRIBER.4 — resolution data carries due
// time + observed fire time.
const timerProfile: DueTimeProfile<"timer"> = {
  kind: "timer",
  decide: (completion, nowMs) =>
    decodeCompletionData(
      TimerCompletionData,
      completionDataError(completion, "timer"),
    )(completion.data).pipe(
      Effect.map((data) => {
        if (data.dueAtMs > nowMs) return { kind: "skip" as const }
        return {
          kind: "resolve" as const,
          result: { dueAtMs: data.dueAtMs, observedFireMs: nowMs },
        }
      }),
    ),
}

// durable-subscribers.SCHEDULED_WORK_SUBSCRIBER.4 — preserve scheduled
// time and opaque input.
const scheduledWorkProfile: DueTimeProfile<"scheduled_work"> = {
  kind: "scheduled_work",
  decide: (completion, nowMs) =>
    decodeCompletionData(
      ScheduledWorkCompletionData,
      completionDataError(completion, "scheduled_work"),
    )(completion.data).pipe(
      Effect.map((data) => {
        if (data.whenMs > nowMs) return { kind: "skip" as const }
        return {
          kind: "resolve" as const,
          result: { whenMs: data.whenMs, input: data.input },
        }
      }),
    ),
}

// durable-subscribers.TIMER_SUBSCRIBER.1, .2, .3, .4, .5
// durable-subscribers.SUBSCRIBER_SCOPE.5 — single-shot scan.
export const runTimerSubscriber = (
  input: SubscriberInput,
): Effect.Effect<TimerSubscriberResult, SubscriberError> =>
  withLoadedSnapshot(input, (snapshot) =>
    runTimerSubscriberFromSnapshot(snapshot, input),
  )

// firegrid-runtime-process.RUNTIME_HOT_PATH.1
// durable-subscribers.SUBSCRIBER_SCOPE.5
// Snapshot-input variant for callers (e.g. the Firegrid runtime
// runner) that already hold a live `SubstrateStreamDB` and want the
// scan to read from it instead of triggering a fresh
// `rebuildProjection()` + `db.preload()` per wake.
export const runTimerSubscriberFromSnapshot = (
  snapshot: ProjectionSnapshot,
  input: SubscriberInput,
): Effect.Effect<TimerSubscriberResult, SubscriberError> =>
  runDueTimeSubscriberFromSnapshot<"timer">(
    snapshot,
    input,
    timerProfile,
  ).pipe(Effect.map((resolvedIds) => ({ resolvedIds })))

// durable-subscribers.SCHEDULED_WORK_SUBSCRIBER.1, .2, .3, .4, .5
export const runScheduledWorkSubscriber = (
  input: SubscriberInput,
): Effect.Effect<ScheduledWorkSubscriberResult, SubscriberError> =>
  withLoadedSnapshot(input, (snapshot) =>
    runScheduledWorkSubscriberFromSnapshot(snapshot, input),
  )

// firegrid-runtime-process.RUNTIME_HOT_PATH.1
export const runScheduledWorkSubscriberFromSnapshot = (
  snapshot: ProjectionSnapshot,
  input: SubscriberInput,
): Effect.Effect<ScheduledWorkSubscriberResult, SubscriberError> =>
  runDueTimeSubscriberFromSnapshot<"scheduled_work">(
    snapshot,
    input,
    scheduledWorkProfile,
  ).pipe(Effect.map((resolvedIds) => ({ resolvedIds })))

// durable-subscribers.PROJECTION_MATCH_SUBSCRIBER.1, .2, .3, .4, .6, .7, .8, .9
// Snapshot-only (.8); per-call evaluator (.7); timeout uses the durable
// deadlineAtMs stored on the row (.9). Snapshot is taken via rebuildProjection
// -> db.preload() which waits for upToDate; that IS the no-gap snapshot
// boundary (.4). Slice 9 never needs the typed unsupported/no-gap fallback
// (.5) — that fires when a future live-follow profile cannot prove the
// boundary.
type ProjectionMatchOutcome =
  | { readonly kind: "resolved"; readonly id: string }
  | { readonly kind: "cancelled"; readonly id: string }

export const runProjectionMatchSubscriber = (
  input: ProjectionMatchSubscriberInput,
): Effect.Effect<ProjectionMatchSubscriberResult, SubscriberError> =>
  withLoadedSnapshot(input, (snapshot) =>
    runProjectionMatchSubscriberFromSnapshot(snapshot, input),
  )

// firegrid-runtime-process.RUNTIME_HOT_PATH.1
// Snapshot-input variant for callers that already hold a live
// `SubstrateStreamDB`; the scan reads from the supplied snapshot
// instead of triggering a fresh `rebuildProjection()` + `db.preload()`.
export const runProjectionMatchSubscriberFromSnapshot = (
  snapshot: ProjectionSnapshot,
  input: ProjectionMatchSubscriberInput,
): Effect.Effect<ProjectionMatchSubscriberResult, SubscriberError> =>
  Effect.gen(function* () {
    const flat = yield* scanPendingCompletions(
      snapshot,
      input,
      "projection_match",
      (ctx, completion) =>
        processProjectionMatchCandidate(
          ctx.stream,
          snapshot,
          completion,
          ctx.nowMs,
          input.evaluate,
        ),
    )
    return {
      resolvedIds: flat.flatMap((o) => (o.kind === "resolved" ? [o.id] : [])),
      cancelledIds: flat.flatMap((o) => (o.kind === "cancelled" ? [o.id] : [])),
    }
  })

const processProjectionMatchCandidate = (
  stream: DurableStream,
  snapshot: ProjectionSnapshot,
  completion: PendingOf<"projection_match">,
  nowMs: number,
  evaluate: ProjectionMatchEvaluator,
): Effect.Effect<Option.Option<ProjectionMatchOutcome>, SubscriberError> =>
  Effect.gen(function* () {
    const data = yield* decodeProjectionMatchCompletionData(
      completion.data,
      completionDataError(completion, "projection_match"),
    )
    const trigger = data.trigger

    // PROJECTION_MATCH_SUBSCRIBER.6 + .9 — timeout fires from the durable
    // deadline, not process-local elapsed time.
    const deadlineAtMs = data.deadlineAtMs
    if (deadlineAtMs !== undefined && nowMs >= deadlineAtMs) {
      const cancelOpt = yield* buildOrSkip(
        cancelCompletion(completion, {
          terminalReason: {
            kind: "timeout" as const,
            ...(data.timeoutMs !== undefined ? { timeoutMs: data.timeoutMs } : {}),
            observedAtMs: nowMs,
          },
        }),
      )
      if (Option.isNone(cancelOpt)) return Option.none()
      yield* appendEvent(stream, cancelOpt.value)
      return Option.some({
        kind: "cancelled" as const,
        id: completion.completionId,
      })
    }

    // PROJECTION_MATCH_SUBSCRIBER.7 — per-call evaluator decides match/no-match.
    // Evaluator failures surface as typed SubscriberEvaluatorError directly.
    const evaluation = yield* evaluate(snapshot, trigger, completion).pipe(
      Effect.mapError(
        (cause) =>
          new SubscriberEvaluatorError({
            completionId: completion.completionId,
            cause,
          }),
      ),
    )
    if (evaluation.kind === "no-match") {
      // .8 — leave pending for a future scan / live-follow.
      return Option.none()
    }
    const eventOpt = yield* buildOrSkip(
      resolveCompletion(completion, {
        result: { matchedValue: evaluation.value },
      }),
    )
    if (Option.isNone(eventOpt)) return Option.none()
    yield* appendEvent(stream, eventOpt.value)
    return Option.some({
      kind: "resolved" as const,
      id: completion.completionId,
    })
  })
