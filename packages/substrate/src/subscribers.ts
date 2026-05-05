import { DurableStream } from "@durable-streams/client"
import { Clock, Data, Effect, Option } from "effect"
import type { ProjectionSnapshot } from "./projection.ts"
import type { CompletionKind, CompletionValue } from "./schema/rows.ts"
import {
  cancelCompletion,
  IllegalCompletionTransition,
  resolveCompletion,
} from "./state-machine.ts"
import { rebuildProjection } from "./stream.ts"
import type { ProjectionMatchTrigger } from "./waits.ts"

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

const appendEvent = (stream: DurableStream, event: unknown) =>
  Effect.tryPromise({
    try: () => stream.append(JSON.stringify(event)),
    catch: (cause) => new SubscriberStreamError({ cause }),
  })

// Defensive wrap: state-machine builders throw IllegalCompletionTransition
// synchronously for direct callers. In a subscriber loop that throw is a race
// signal (another writer terminalized between our snapshot read and our
// append attempt). Map IllegalCompletionTransition -> Option.none so the
// caller skips this completion silently. Authority remains the first-valid-
// terminal fold (durable-subscribers.COMPLETION_AUTHORITY.1/.2).
const tryBuildOrSkip = <A>(build: () => A): Effect.Effect<Option.Option<A>> =>
  Effect.try({
    try: build,
    catch: (cause): IllegalCompletionTransition => {
      if (cause instanceof IllegalCompletionTransition) return cause
      throw cause
    },
  }).pipe(
    Effect.map(Option.some),
    Effect.catchAll(() => Effect.succeed(Option.none())),
  )

// Shared scan skeleton for due-time-driven subscribers (timer / scheduled_work).
// The per-profile `decide` function inspects the completion at the current
// clock reading and returns one of three decisions; the skeleton handles the
// snapshot, filtering, sequential forEach, race-safe build, and append.
type DueTimeDecision =
  | { readonly kind: "data-error"; readonly reason: string }
  | { readonly kind: "skip" }
  | { readonly kind: "resolve"; readonly result: unknown }

interface DueTimeProfile<K extends "timer" | "scheduled_work"> {
  readonly kind: K
  readonly decide: (
    completion: PendingOf<K>,
    nowMs: number,
  ) => DueTimeDecision
}

const runDueTimeSubscriberFromSnapshot = <
  K extends "timer" | "scheduled_work",
>(
  snapshot: ProjectionSnapshot,
  input: SubscriberInput,
  profile: DueTimeProfile<K>,
): Effect.Effect<ReadonlyArray<string>, SubscriberError> =>
  Effect.gen(function* () {
    const stream = openStream(input)
    const nowMs = yield* Clock.currentTimeMillis
    const outcomes = yield* Effect.forEach(
      collectPending(snapshot, profile.kind),
      (completion) =>
        processDueTimeCandidate(stream, completion, nowMs, profile.decide),
    )
    return outcomes.flatMap(Option.toArray)
  })

const processDueTimeCandidate = <K extends "timer" | "scheduled_work">(
  stream: DurableStream,
  completion: PendingOf<K>,
  nowMs: number,
  decide: (completion: PendingOf<K>, nowMs: number) => DueTimeDecision,
): Effect.Effect<Option.Option<string>, SubscriberError> =>
  Effect.gen(function* () {
    const decision = decide(completion, nowMs)
    if (decision.kind === "data-error") {
      return yield* new SubscriberDataError({
        completionId: completion.completionId,
        reason: decision.reason,
      })
    }
    if (decision.kind === "skip") return Option.none()
    const eventOpt = yield* tryBuildOrSkip(() =>
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
  decide: (completion, nowMs) => {
    const data = completion.data as { readonly dueAtMs?: unknown } | undefined
    if (data === undefined || typeof data.dueAtMs !== "number") {
      return { kind: "data-error", reason: "missing or invalid dueAtMs" }
    }
    if (data.dueAtMs > nowMs) return { kind: "skip" }
    return {
      kind: "resolve",
      result: { dueAtMs: data.dueAtMs, observedFireMs: nowMs },
    }
  },
}

// durable-subscribers.SCHEDULED_WORK_SUBSCRIBER.4 — preserve scheduled
// time and opaque input.
const scheduledWorkProfile: DueTimeProfile<"scheduled_work"> = {
  kind: "scheduled_work",
  decide: (completion, nowMs) => {
    const data = completion.data as
      | { readonly whenMs?: unknown; readonly input?: unknown }
      | undefined
    if (data === undefined || typeof data.whenMs !== "number") {
      return { kind: "data-error", reason: "missing or invalid whenMs" }
    }
    if (data.whenMs > nowMs) return { kind: "skip" }
    return {
      kind: "resolve",
      result: { whenMs: data.whenMs, input: data.input },
    }
  },
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
    const stream = openStream(input)
    const nowMs = yield* Clock.currentTimeMillis
    const outcomes = yield* Effect.forEach(
      collectPending(snapshot, "projection_match"),
      (completion) =>
        processProjectionMatchCandidate(
          stream,
          snapshot,
          completion,
          nowMs,
          input.evaluate,
        ),
    )
    const flat = outcomes.flatMap(Option.toArray)
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
    const data = completion.data as
      | {
          readonly trigger?: unknown
          readonly timeoutMs?: unknown
          readonly deadlineAtMs?: unknown
        }
      | undefined
    if (data === undefined || data.trigger === undefined) {
      return yield* new SubscriberDataError({
        completionId: completion.completionId,
        reason: "missing trigger",
      })
    }
    const trigger = data.trigger as ProjectionMatchTrigger

    // PROJECTION_MATCH_SUBSCRIBER.6 + .9 — timeout fires from the durable
    // deadline, not process-local elapsed time.
    const deadlineAtMs =
      typeof data.deadlineAtMs === "number" ? data.deadlineAtMs : undefined
    if (deadlineAtMs !== undefined && nowMs >= deadlineAtMs) {
      const cancelOpt = yield* tryBuildOrSkip(() =>
        cancelCompletion(completion, {
          terminalReason: {
            kind: "timeout" as const,
            ...(typeof data.timeoutMs === "number"
              ? { timeoutMs: data.timeoutMs }
              : {}),
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
    const eventOpt = yield* tryBuildOrSkip(() =>
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
