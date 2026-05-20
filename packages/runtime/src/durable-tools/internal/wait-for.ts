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
 *  - firegrid-durable-tools.TIMEOUT.3/4 — match preempts timeout; arbitrated
 *    by `DurableDeferred.raceAll`'s race deferred (Shape C Step 2 — no
 *    completion-table read/write needed; idempotent `engine.deferredDone` +
 *    first-writer-wins on the race deferred make exactly-once safe)
 *  - firegrid-durable-tools.LIFECYCLE.2 — per-dispatch wait re-check (the
 *    router enforces the match side; the timeout side has no wait-row work
 *    to do under Shape C)
 *  - firegrid-durable-tools.EFFECT_IDIOMS.2 — Clock.currentTimeMillis
 *  - firegrid-durable-tools.EFFECT_IDIOMS.3 — Match.tag dispatch
 *
 * Shape C Step 2 + Step 3 (docs/research/durable-tools-vs-workflow-engine-convergence.md):
 * the timeout side no longer reads `WaitCompletionRow` to preempt itself and
 * no longer writes a timeout completion row — the `completions` table is
 * gone. Arbitration is the existing `DurableDeferred.raceAll` race deferred,
 * which is idempotent-first-writer-wins. If a match has been recorded on the
 * match deferred before the timeout's `DurableClock.sleep` ends, the
 * match-side fiber awakes (Firegrid engine guarantees idempotent
 * `deferredDone` and synchronous awaiter wake on resume) and writes Match to
 * the race deferred; the timeout-side's later Timeout write loses the race.
 * The previous "read completions to preempt" branch was a second mechanism
 * the convergence doc confirmed redundant.
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
  DurableWaitRowLookup,
  DurableWaitRowUpsert,
} from "./durable-wait-store.ts"
import { emitSpanEvent, waitRowId } from "./span-events.ts"
import {
  type FieldEqualsTrigger,
  FieldEqualsTriggerSchema,
  type RuntimeWaitSource,
  type WaitForOutcome,
  type WaitForError,
  waitForError,
} from "./types.ts"
import { waitKeySpanAttributes } from "./observability.ts"

const RawMatchSchema = Schema.Struct({
  _tag: Schema.Literal("Match"),
  raw: Schema.Unknown,
})

const RawTimeoutSchema = Schema.Struct({
  _tag: Schema.Literal("Timeout"),
})

const RawOutcomeSchema = Schema.Union(RawMatchSchema, RawTimeoutSchema)
type RawOutcome = Schema.Schema.Type<typeof RawOutcomeSchema>

const durableWaitBucketAttribute = {
  "firegrid.wait.bucket": "durable",
} as const

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
        ...durableWaitBucketAttribute,
        ...waitKeySpanAttributes({ executionId: row.executionId, name: waitName }),
        "firegrid.wait.source": row.source._tag,
        "firegrid.wait.has_timeout": row.deadlineMs !== undefined,
      },
    }),
  )

/**
 * Mark a timed-out wait row as `timed_out` for the router's lifecycle
 * re-check (firegrid-durable-tools.LIFECYCLE.2).
 *
 * Shape C Step 2: this no longer participates in match/timeout arbitration
 * — the race is decided by `DurableDeferred.raceAll`'s race deferred. The
 * status flip is a best-effort observability/lifecycle update only; failures
 * are logged but do not change the timeout's outcome. The wait row is still
 * required (router restart re-attach, doc lines 54-59) and is the durable
 * artifact the per-dispatch re-check reads to skip retired/completed waits.
 *
 * firegrid-durable-tools.TIMEOUT.3 — the race deferred is the arbiter.
 * firegrid-durable-tools.TIMEOUT.4 — a late-firing timeout is a no-op via
 *   the `engine.deferredResult(raceDeferred)` short-circuit at the top of
 *   `DurableDeferred.raceAll` on replay; no completion-row scan needed.
 */
const markWaitTimedOut = (
  waitName: string,
  waitKey: { readonly executionId: string; readonly name: string },
  waitLookup: DurableWaitRowLookup["Type"],
  waitUpsert: DurableWaitRowUpsert["Type"],
): Effect.Effect<void, never> =>
  Effect.gen(function*() {
    const existing = yield* waitLookup.find(waitKey)
    if (Option.isNone(existing)) return
    const current = existing.value
    if (current.status !== "active") return
    yield* waitUpsert.upsert({ ...current, status: "timed_out" })
  }).pipe(
    Effect.catchAll(cause =>
      Effect.logWarning("[durable-tools] wait-for/timeout: failed marking wait timed_out").pipe(
        Effect.annotateLogs({ waitName, cause }),
      )),
    Effect.withSpan("firegrid.durable_tools.wait_for.timeout.mark_wait", {
      kind: "internal",
      attributes: {
        ...durableWaitBucketAttribute,
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
  | Scope.Scope
>

const matchImpl = <A = unknown>(
  options: WaitForOptions<A>,
): MatchImplResult<A> =>
  Effect.gen(function*() {
    const instance = yield* WorkflowEngine.WorkflowInstance
    const waitLookup = yield* DurableWaitRowLookup
    const waitUpsert = yield* DurableWaitRowUpsert
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
    // #429 produces the wait-registrar trace context via stampRowOtel above;
    // #428 emits a `wait.registered` span event with elapsed time. Both
    // compose: the row is stamped before insert; the event fires after the
    // upsert returns the registered row so elapsed_ms is measured against
    // the row's persisted createdAtMs.
    const registeredRow = yield* upsertActiveWait(options.name, baseRow, waitLookup, waitUpsert)
    const registeredAtMs = yield* Clock.currentTimeMillis
    yield* emitSpanEvent("wait.registered", {
      "firegrid.workflow.execution_id": registeredRow.executionId,
      "firegrid.wait.name": registeredRow.waitKey.name,
      "firegrid.wait.row_id": waitRowId(registeredRow.waitKey),
      "firegrid.wait.source": registeredRow.source._tag,
      "firegrid.wait.status": registeredRow.status,
      "firegrid.wait.elapsed_ms": Math.max(0, registeredAtMs - registeredRow.createdAtMs),
    })
    const matchDeferred = matchDeferredFor(deferredName)
    return options.timeoutMs === undefined
      ? yield* matchOnlyFlow(options, matchDeferred)
      : yield* matchOrTimeoutFlow(
        options,
        matchDeferred,
        waitLookup,
        waitUpsert,
        waitKey,
      )
  }).pipe(
    Effect.withSpan("firegrid.durable_tools.wait_for.match", {
      kind: "internal",
      attributes: {
        ...durableWaitBucketAttribute,
        "firegrid.wait.name": options.name,
        "firegrid.wait.source": options.source._tag,
        "firegrid.wait.has_timeout": options.timeoutMs !== undefined,
      },
    }),
  )

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
  waitKey: { readonly executionId: string; readonly name: string },
): Effect.Effect<
  WaitForOutcome<A>,
  WaitForError | ParseResult.ParseError,
  WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> =>
  Effect.gen(function*() {
    // firegrid-durable-tools.TIMEOUT.1
    // firegrid-durable-tools.TIMEOUT.3 / .4 — Shape C Step 2: the race
    // deferred is the sole arbiter. `DurableDeferred.raceAll` builds a
    // durable race deferred and writes the first-completer's exit to it
    // (idempotent-first-writer-wins via Firegrid's `engine.deferredDone`,
    // finding #1 of the convergence doc). Match wakes when the router fires
    // `matchDeferred`; timeout wakes when `DurableClock.sleep` returns. The
    // previous "timeout-side reads completions to preempt" branch is removed
    // — it was a redundant second mechanism. The wait row's status flip to
    // `timed_out` runs after `raceAll` resolves and is observability /
    // lifecycle re-check support only (not arbitration). raceAll carries
    // `Schema.Never` on its error channel, so both sides must be infallible.
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
      Effect.as({ _tag: "Timeout" as const }),
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
          // Best-effort lifecycle flip: mark the wait row `timed_out` for
          // the router's per-dispatch re-check. raceAll has already decided
          // the outcome; this write is observability only and any error is
          // logged (see `markWaitTimedOut`), never failing the wait.
          markWaitTimedOut(options.name, waitKey, waitLookup, waitUpsert).pipe(
            Effect.as({ _tag: "Timeout" } satisfies WaitForOutcome<A>),
          ),
      ),
      Match.exhaustive,
    )
  })

export const WaitFor = {
  match: matchImpl,
}
