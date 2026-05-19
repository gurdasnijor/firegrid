/**
 * Workflow-handler-facing `wait_for` surface: `WaitFor.match`.
 *
 * Implements:
 *  - firegrid-durable-tools.WAIT_FOR.1 — handler-callable; suspends until
 *    match or optional timeout
 *  - firegrid-durable-tools.WAIT_FOR.2 — deterministic wait key from
 *    (executionId, name)
 *  - firegrid-durable-tools.WAIT_FOR.3 — call-site decode of raw payload via
 *    optional `resultSchema`
 *  - firegrid-durable-tools.WAIT_FOR.4 — discriminated Match | Timeout
 *  - firegrid-durable-tools.WAIT_FOR.5 — runtime-only surface; not exposed via
 *    @firegrid/client
 *  - firegrid-durable-tools.WAIT_FOR.6 — single resolution across replay
 *  - firegrid-durable-tools.TIMEOUT.1 — uses @effect/workflow clock semantics
 *  - firegrid-durable-tools.TIMEOUT.2 — typed timeout exit
 *  - firegrid-durable-tools.TIMEOUT.3/4 — match preempts timeout; late-fire
 *    is a no-op via the wait-row re-check
 *  - firegrid-durable-tools.LIFECYCLE.2 — per-dispatch wait re-check (timeout
 *    side; the router enforces the match side)
 *  - firegrid-durable-tools.EFFECT_IDIOMS.2 — Clock.currentTimeMillis
 *  - firegrid-durable-tools.EFFECT_IDIOMS.3 — Match.tag dispatch
 */

import {
  DurableClock,
  DurableDeferred,
  WorkflowEngine,
} from "@effect/workflow"
import {
  Clock,
  Duration,
  Effect,
  Match,
  Option,
  ParseResult,
  Schema,
  type Scope,
} from "effect"
import { type DurableTableError } from "effect-durable-operators"
import { stampRowOtel } from "@firegrid/protocol/otel"
import { type WaitRow } from "./table.ts"
import {
  DurableWaitCompletionRowLookup,
  DurableWaitCompletionRowUpsert,
  DurableWaitRowLookup,
  DurableWaitRowUpsert,
} from "./durable-wait-store.ts"
import {
  type FieldEqualsTrigger,
  FieldEqualsTriggerSchema,
  type RuntimeWaitSource,
  type WaitForOutcome,
  type WaitForError,
  waitForError,
} from "./types.ts"

const RawMatchSchema = Schema.Struct({
  _tag: Schema.Literal("Match"),
  raw: Schema.Unknown,
})

const RawTimeoutSchema = Schema.Struct({
  _tag: Schema.Literal("Timeout"),
})

const RawOutcomeSchema = Schema.Union(RawMatchSchema, RawTimeoutSchema)
type RawOutcome = Schema.Schema.Type<typeof RawOutcomeSchema>

/**
 * The match deferred carries the raw matched-row payload — `Schema.Unknown`
 * because the router does not decode through a call-site schema
 * (SUBSCRIPTION.3).
 */
export const matchDeferredFor = (deferredName: string) =>
  DurableDeferred.make<typeof Schema.Unknown>(deferredName, {
    success: Schema.Unknown,
  })

const deferredNameFor = (waitName: string): string => `wait-for/${waitName}`

const raceDeferredNameFor = (waitName: string): string =>
  `wait-for/${waitName}/race`

const clockNameFor = (waitName: string): string =>
  `wait-for/${waitName}/clock`

export interface WaitForOptions<A = unknown> {
  /**
   * Unique within the workflow execution. Combined with `executionId` to form
   * the durable wait identity.
   *
   * firegrid-durable-tools.WAIT_FOR.2
   */
  readonly name: string
  /**
   * Typed runtime wait source. Selects which runtime observation stream the
   * router observes. firegrid-typed-wait-source-redesign.TYPED_SOURCES.1
   */
  readonly source: RuntimeWaitSource
  /**
   * AND-of-scalar-equality predicates over decoded row paths.
   *
   * firegrid-durable-tools.SUBSCRIPTION.4
   * firegrid-durable-tools.SUBSCRIPTION.6
   */
  readonly trigger: FieldEqualsTrigger
  /**
   * Optional call-site decoder. If omitted, the matched row is returned as
   * `unknown`. Any Effect Schema whose decoded type is `A` is accepted; the
   * encoded form is unconstrained because the router emits the raw row
   * payload as `unknown` (firegrid-durable-tools.SUBSCRIPTION.3).
   */
  readonly resultSchema?: // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the router emits `unknown` and the encoded type of the caller's schema is irrelevant here; using `unknown` would refuse concrete Struct schemas.
  Schema.Schema<A, any, never>
  /**
   * Optional timeout. Implemented through `DurableClock.sleep`.
   *
   * firegrid-durable-tools.TIMEOUT.1
   */
  readonly timeoutMs?: number
}

const upsertActiveWait = (
  waitName: string,
  row: WaitRow,
  waitLookup: DurableWaitRowLookup["Type"],
  waitUpsert: DurableWaitRowUpsert["Type"],
) =>
  Effect.gen(function*() {
    const existing = yield* Effect.mapError(
      waitLookup.find({ executionId: row.executionId, name: waitName }),
      (cause) =>
        waitForError({
          op: "wait-for/upsert",
          waitName,
          message: "failed reading wait row",
          cause,
        }),
    )
    if (Option.isSome(existing)) return existing.value
    yield* Effect.mapError(waitUpsert.upsert(row), (cause) =>
      waitForError({
        op: "wait-for/upsert",
        waitName,
        message: "failed writing wait row",
        cause,
      }),
    )
    return row
  }).pipe(
    Effect.withSpan("firegrid.durable_tools.wait_for.upsert_active", {
      kind: "internal",
      attributes: {
        "firegrid.workflow.execution_id": row.executionId,
        "firegrid.wait.name": waitName,
        "firegrid.wait.source": row.source._tag,
        "firegrid.wait.has_timeout": row.deadlineMs !== undefined,
      },
    }),
  )

/**
 * Resolve the timeout side.
 *
 * Returns the matched-row payload (`Option.some`) when a `match` completion
 * already exists — the timeout side must then resolve as **Match**, never
 * Timeout. Returns `Option.none()` when the wait genuinely timed out (a
 * timeout completion is written and the wait flipped to `timed_out`).
 *
 * firegrid-durable-tools.TIMEOUT.3 — match preempts timeout.
 * firegrid-durable-tools.TIMEOUT.4 — a late-firing timeout is a no-op: when
 *   a match completion is already durably recorded (including the
 *   completion-written-but-deferredDone-not-yet-fired crash gap that
 *   firegrid-durable-tools.WAIT_FOR.7 preserves), the timeout cannot win
 *   the race. The stored `matchedRowPayload` is authoritative, so the
 *   timeout side resolves directly to that match rather than waiting on the
 *   match deferred to be re-fired by the live-replay path.
 */
const writeTimeoutCompletion = (
  waitName: string,
  waitKey: { readonly executionId: string; readonly name: string },
  waitLookup: DurableWaitRowLookup["Type"],
  waitUpsert: DurableWaitRowUpsert["Type"],
  completionLookup: DurableWaitCompletionRowLookup["Type"],
  completionUpsert: DurableWaitCompletionRowUpsert["Type"],
): Effect.Effect<Option.Option<unknown>, WaitForError> =>
  Effect.gen(function*() {
    // Check for an existing completion FIRST, before any wait-status gate.
    // A `match` completion preempts the timeout regardless of the wait
    // row's status (covers the WAIT_FOR.7 crash gap where the completion
    // row is written but the status flip / deferredDone never landed).
    const existingCompletion = yield* Effect.mapError(
      completionLookup.find(waitKey),
      (cause) =>
        waitForError({
          op: "wait-for/timeout",
          waitName,
          message: "failed reading existing completion row",
          cause,
        }),
    )
    if (Option.isSome(existingCompletion)) {
      return existingCompletion.value.outcome === "match"
        ? Option.some(existingCompletion.value.matchedRowPayload)
        : Option.none()
    }
    const existing = yield* Effect.mapError(
      waitLookup.find(waitKey),
      (cause) =>
        waitForError({
          op: "wait-for/timeout",
          waitName,
          message: "failed reading wait row during timeout",
          cause,
        }),
    )
    if (Option.isNone(existing)) return Option.none()
    const current = existing.value
    if (current.status !== "active") return Option.none()
    const nowMs = yield* Clock.currentTimeMillis
    yield* Effect.mapError(
      completionUpsert.upsert({
        waitKey,
        outcome: "timeout",
        completedAtMs: nowMs,
      }),
      (cause) =>
        waitForError({
          op: "wait-for/timeout",
          waitName,
          message: "failed writing timeout completion row",
          cause,
        }),
    )
    yield* Effect.mapError(
      waitUpsert.upsert({ ...current, status: "timed_out" }),
      (cause) =>
        waitForError({
          op: "wait-for/timeout",
          waitName,
          message: "failed marking wait timed_out",
          cause,
        }),
    )
    return Option.none()
  }).pipe(
    Effect.withSpan("firegrid.durable_tools.wait_for.timeout_completion.write", {
      kind: "internal",
      attributes: {
        "firegrid.workflow.execution_id": waitKey.executionId,
        "firegrid.wait.name": waitName,
      },
    }),
  )

const decodeMatchPayload = <A>(
  waitName: string,
  raw: unknown,
  resultSchema: // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the router emits `unknown` and the encoded type of the caller's schema is irrelevant here; using `unknown` would refuse concrete Struct schemas.
  Schema.Schema<A, any, never> | undefined,
): Effect.Effect<A, WaitForError | ParseResult.ParseError> => {
  if (resultSchema === undefined) {
    return Effect.succeed(raw as A)
  }
  return Schema.decodeUnknown(resultSchema)(raw).pipe(
    Effect.mapError((cause) => {
      if (cause instanceof ParseResult.ParseError) return cause
      return waitForError({
        op: "wait-for/decode",
        waitName,
        message: "failed decoding matched row payload",
        cause,
      })
    }),
  )
}

/**
 * firegrid-durable-tools.WAIT_FOR.1
 *
 * The single workflow-handler-facing entrypoint. Persists a wait intent,
 * suspends on the match deferred (and, with `timeoutMs`, races against a
 * DurableClock sleep), then decodes the raw matched-row payload at the call
 * site.
 */
type MatchImplResult<A> = Effect.Effect<
  WaitForOutcome<A>,
  WaitForError | ParseResult.ParseError | DurableTableError,
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance
  | DurableWaitRowLookup
  | DurableWaitRowUpsert
  | DurableWaitCompletionRowLookup
  | DurableWaitCompletionRowUpsert
  | Scope.Scope
>

const matchImpl = <A = unknown>(
  options: WaitForOptions<A>,
): MatchImplResult<A> =>
  Effect.gen(function*() {
    const instance = yield* WorkflowEngine.WorkflowInstance
    const waitLookup = yield* DurableWaitRowLookup
    const waitUpsert = yield* DurableWaitRowUpsert
    const completionLookup = yield* DurableWaitCompletionRowLookup
    const completionUpsert = yield* DurableWaitCompletionRowUpsert
    const waitKey = {
      executionId: instance.executionId,
      name: options.name,
    }
    const deferredName = deferredNameFor(options.name)
    const nowMs = yield* Clock.currentTimeMillis
    // firegrid-durable-tools.WAIT_FOR.2
    // Validate trigger shape at the boundary; the router consumes the
    // already-validated value.
    yield* Schema.decodeUnknown(FieldEqualsTriggerSchema)(options.trigger).pipe(
      Effect.mapError((cause) => {
        if (cause instanceof ParseResult.ParseError) return cause
        return waitForError({
          op: "wait-for/validate",
          waitName: options.name,
          message: "invalid fieldEquals trigger",
          cause,
        })
      }),
    )
    // Stamp the wait_registrar trace context onto the wait row BEFORE the
    // upsert internal span fires — this captures whatever workflow handler
    // span called wait_for (semantically "the registrar"), not the inner
    // upsert span. The router-side `complete_match` consumer turns this into
    // the wait-registrar `SpanLink` on the match span.
    const baseRow = yield* stampRowOtel({
      waitKey,
      workflowName: instance.workflow.name,
      executionId: instance.executionId,
      deferredName,
      source: options.source,
      trigger: options.trigger,
      status: "active" as const,
      createdAtMs: nowMs,
      ...(options.timeoutMs === undefined
        ? {}
        : { deadlineMs: nowMs + options.timeoutMs }),
    } satisfies WaitRow)
    yield* upsertActiveWait(options.name, baseRow, waitLookup, waitUpsert)
    const matchDeferred = matchDeferredFor(deferredName)
    return options.timeoutMs === undefined
      ? yield* matchOnlyFlow(options, matchDeferred)
      : yield* matchOrTimeoutFlow(
        options,
        matchDeferred,
        waitLookup,
        waitUpsert,
        completionLookup,
        completionUpsert,
        waitKey,
      )
  })

const matchOnlyFlow = <A>(
  options: WaitForOptions<A>,
  matchDeferred: ReturnType<typeof matchDeferredFor>,
): Effect.Effect<
  WaitForOutcome<A>,
  WaitForError | ParseResult.ParseError,
  WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> =>
  Effect.gen(function*() {
    const raw = yield* DurableDeferred.await(matchDeferred)
    const decoded = yield* decodeMatchPayload(
      options.name,
      raw,
      options.resultSchema,
    )
    return { _tag: "Match", row: decoded } satisfies WaitForOutcome<A>
  })

const matchOrTimeoutFlow = <A>(
  options: WaitForOptions<A>,
  matchDeferred: ReturnType<typeof matchDeferredFor>,
  waitLookup: DurableWaitRowLookup["Type"],
  waitUpsert: DurableWaitRowUpsert["Type"],
  completionLookup: DurableWaitCompletionRowLookup["Type"],
  completionUpsert: DurableWaitCompletionRowUpsert["Type"],
  waitKey: { readonly executionId: string; readonly name: string },
): Effect.Effect<
  WaitForOutcome<A>,
  WaitForError | ParseResult.ParseError,
  WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> =>
  Effect.gen(function*() {
    // firegrid-durable-tools.TIMEOUT.1
    // firegrid-durable-tools.TIMEOUT.3 — raceAll captures the first writer to
    // the race deferred and interrupts the loser. Internal timeout-write
    // errors are turned into defects so the race deferred carries a Never
    // error channel and matches `Schema.Never`.
    const matchSide: Effect.Effect<
      RawOutcome,
      never,
      WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
    > = DurableDeferred.await(matchDeferred).pipe(
      Effect.map((raw): RawOutcome => ({ _tag: "Match", raw })),
    )
    const timeoutSide: Effect.Effect<
      RawOutcome,
      never,
      WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
    > = DurableClock.sleep({
      name: clockNameFor(options.name),
      duration: Duration.millis(options.timeoutMs!),
      // Always take the durable clock path so the workflow body suspends
      // while waiting for the deadline. An in-memory `Effect.sleep` would
      // pin the workflow fiber and prevent the engine from observing a
      // concurrent match-side `deferredDone` from the router until the
      // sleep completes. firegrid-durable-tools.TIMEOUT.1
      inMemoryThreshold: Duration.zero,
    }).pipe(
      Effect.zipRight(
        writeTimeoutCompletion(
          options.name,
          waitKey,
          waitLookup,
          waitUpsert,
          completionLookup,
          completionUpsert,
        ).pipe(
          Effect.orDie,
        ),
      ),
      // firegrid-durable-tools.TIMEOUT.3 / .4 — if a match completion is
      // already recorded, the timeout side resolves as Match using the
      // authoritative stored payload; it must never win the race as
      // Timeout once a match exists.
      Effect.map((preempted): RawOutcome =>
        Option.isSome(preempted)
          ? { _tag: "Match", raw: preempted.value }
          : { _tag: "Timeout" }),
    )
    const raw: RawOutcome = yield* DurableDeferred.raceAll({
      name: raceDeferredNameFor(options.name),
      success: RawOutcomeSchema,
      error: Schema.Never,
      effects: [matchSide, timeoutSide],
    })
    return yield* Match.value(raw).pipe(
      Match.tag(
        "Match",
        ({ raw }): Effect.Effect<
          WaitForOutcome<A>,
          WaitForError | ParseResult.ParseError
        > =>
          Effect.map(
            decodeMatchPayload(options.name, raw, options.resultSchema),
            (row): WaitForOutcome<A> => ({ _tag: "Match", row }),
          ),
      ),
      Match.tag(
        "Timeout",
        (): Effect.Effect<WaitForOutcome<A>> =>
          Effect.succeed({ _tag: "Timeout" } satisfies WaitForOutcome<A>),
      ),
      Match.exhaustive,
    )
  }).pipe(
    Effect.withSpan("firegrid.durable_tools.wait_for.match", {
      kind: "internal",
      attributes: {
        "firegrid.wait.name": options.name,
        "firegrid.wait.source": options.source._tag,
        "firegrid.wait.has_timeout": options.timeoutMs !== undefined,
      },
    }),
  )

export const WaitFor = {
  match: matchImpl,
}
